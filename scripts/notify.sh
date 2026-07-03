#!/bin/bash
# cc-notify — main notification script
# Usage:
#   arg mode:   notify.sh [--provider claude|codex] [--urgent] [--force] "title line" ["line 2" ...]
#   stdin mode: echo '{"session_id":"..."}' | notify.sh                       (Stop hook)
#
# Flags (any order, must precede content args):
#   --urgent  displays the sticky note in a bold red urgent theme to stand out from regular notifications
#   --force   bypass deduplication — always trigger the notification even if content is identical to last time
#   --provider claude|codex  namespace hook state and parse provider-specific hook JSON

# Resolve the install directory; all dependencies live here (self-locating)
SKILL_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="$SKILL_SCRIPTS/sticky-notify.app/Contents/MacOS/sticky-notify-app"
TIMESTAMP=$(date '+%H:%M:%S')

# Parse flags first so provider/session are available for logging and state paths.
PROVIDER="claude"
URGENT=0
FORCE=0
STATE=""
SESSION_KEY_OVERRIDE=""
while true; do
    case "${1:-}" in
        --urgent) URGENT=1; shift ;;
        --force)  FORCE=1;  shift ;;
        --state)
            STATE="${2:-working}"
            shift 2
            ;;
        --state=*)
            STATE="${1#--state=}"
            shift
            ;;
        --provider)
            PROVIDER="${2:-claude}"
            shift 2
            ;;
        --provider=*)
            PROVIDER="${1#--provider=}"
            shift
            ;;
        --session)
            SESSION_KEY_OVERRIDE="${2:-}"
            shift 2
            ;;
        --session=*)
            SESSION_KEY_OVERRIDE="${1#--session=}"
            shift
            ;;
        *) break ;;
    esac
done

# Default state: --urgent implies approval; stdin mode implies completed; otherwise working
if [ -z "$STATE" ]; then
    if [ "$URGENT" = "1" ]; then
        STATE="approval"
    elif [ $# -eq 0 ]; then
        STATE="completed"
    else
        STATE="working"
    fi
fi

case "$PROVIDER" in
    claude|codex) ;;
    *) PROVIDER="claude" ;;
esac

json_get_string() {
    _key="$1"
    printf '%s' "$HOOK_JSON" | sed -nE 's/.*"'"$_key"'"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1
}

json_get_first_string() {
    for _json_key in "$@"; do
        _json_value=$(json_get_string "$_json_key" 2>/dev/null || true)
        if [ -n "$_json_value" ]; then
            printf '%s' "$_json_value"
            return 0
        fi
    done
    return 1
}

clean_prompt_label() {
    printf '%s' "$1" \
        | sed 's/\\n/ /g; s/\\r/ /g; s/\\t/ /g; s/[[:space:]]\{1,\}/ /g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
        | cut -c 1-28
}

is_codex_temp_cwd() {
    [ "$PROVIDER" = "codex" ] || return 1
    _cwd="$1"
    _base="$2"
    case "$_cwd" in
        /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*|"$HOME"/Documents/Codex/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/*) ;;
        *) return 1 ;;
    esac
    # Codex App sessions without an explicit project can report a short,
    # random-looking temp/project directory as cwd; avoid showing that as a project.
    printf '%s' "$_base" | grep -Eq '^[A-Za-z0-9_-]{1,16}$'
}

resolve_project_label() {
    _cwd="${PROJECT_CWD:-$(pwd)}"
    _base=$(basename "$_cwd")
    _project_file="/tmp/cc-notify/${STATE_KEY}.project"
    mkdir -p "/tmp/cc-notify" 2>/dev/null || true

    if is_codex_temp_cwd "$_cwd" "$_base"; then
        _prompt=$(json_get_first_string prompt user_prompt userPrompt message 2>/dev/null || true)
        _prompt=$(clean_prompt_label "$_prompt")
        if [ -n "$_prompt" ]; then
            _label="会话：$_prompt"
            printf '%s\n' "$_label" > "$_project_file" 2>/dev/null || true
            printf '%s' "$_label"
            return 0
        fi
        if [ -f "$_project_file" ]; then
            _saved=$(cat "$_project_file" 2>/dev/null || true)
            if [ -n "$_saved" ]; then
                printf '%s' "$_saved"
                return 0
            fi
        fi
        printf '%s' '会话'
        return 0
    fi

    printf '%s' "$_base"
}

# ── Codex session-end watcher ─────────────────────────────────────────────────
# Codex has no SessionEnd hook (its hook events include UserPromptSubmit /
# PreToolUse / PermissionRequest / PostToolUse / Stop, but no SessionEnd).
# Claude Code closes the sticky note via a real SessionEnd hook (see
# HOOK_DEFINITIONS in lib/commands/init.js). For Codex we instead launch a
# SINGLE lightweight background watcher that polls the Codex main process.
#
# Design: one watcher per Codex instance, NOT per session.  Sessions register
# themselves in /tmp/cc-notify/_codex_sessions; when the watcher detects Codex
# has exited, it calls --state close for every registered session at once.
# This avoids accumulating watcher processes across sessions.
ensure_codex_watcher() {
    [ "$PROVIDER" = "codex" ] || return 0
    [ "$STATE" = "close" ] && return 0

    local _td="/tmp/cc-notify"
    local _sessions_file="$_td/_codex_sessions"
    local _watcher_pid_file="$_td/_codex_watcher.pid"
    mkdir -p "$_td" 2>/dev/null

    # ── Register this session ──────────────────────────────────────────────
    if [ -f "$_sessions_file" ]; then
        if ! grep -qxF "$STATE_KEY" "$_sessions_file" 2>/dev/null; then
            printf '%s\n' "$STATE_KEY" >> "$_sessions_file"
        fi
    else
        printf '%s\n' "$STATE_KEY" > "$_sessions_file"
    fi

    # ── Global watcher already running? ────────────────────────────────────
    if [ -f "$_watcher_pid_file" ]; then
        local _wp
        _wp=$(cat "$_watcher_pid_file" 2>/dev/null)
        if [ -n "$_wp" ] && kill -0 "$_wp" 2>/dev/null; then
            return 0
        fi
    fi

    # ── Find Codex main process ────────────────────────────────────────────
    local _p=$$ _codex_pid="" _pp _comm _i
    for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
        _comm=$(ps -p "$_p" -o comm= 2>/dev/null | sed 's|.*/||' | tr -d ' ')
        [ -n "$_comm" ] && [ "$_comm" = "codex" ] && _codex_pid=$_p
        _pp=$(ps -p "$_p" -o ppid= 2>/dev/null | tr -d ' ')
        if [ -z "$_pp" ] || [ "$_pp" = "0" ] || [ "$_pp" = "1" ]; then break; fi
        _p=$_pp
    done
    # No Codex ancestor (e.g. manual `notify.sh` invocation, tests) — skip.
    # The Swift app's idle auto-close (CC_STICKY_NOTIFY_CLOSE_TIMEOUT) still
    # acts as a fallback.
    [ -n "$_codex_pid" ] || return 0

    # ── Spawn global watcher ───────────────────────────────────────────────
    (
        while kill -0 "$_codex_pid" 2>/dev/null; do
            if [ "$(ps -p "$_codex_pid" -o comm= 2>/dev/null | sed 's|.*/||' | tr -d ' ')" != "codex" ]; then
                break
            fi
            sleep 5
        done
        # Codex exited → close every registered session
        if [ -f "$_sessions_file" ]; then
            while IFS= read -r _sk; do
                [ -n "$_sk" ] || continue
                _sid="${_sk#codex-}"
                "$SKILL_SCRIPTS/notify.sh" --provider codex --state close --session "$_sid" >/dev/null 2>&1
            done < "$_sessions_file"
            rm -f "$_sessions_file" 2>/dev/null
        fi
        rm -f "$_watcher_pid_file" 2>/dev/null
    ) </dev/null >/dev/null 2>&1 &
    local _watcher_pid=$!
    disown "$_watcher_pid" 2>/dev/null || true
    printf '%s' "$_watcher_pid" > "$_watcher_pid_file" 2>/dev/null
    _log "WATCHER start global codex_pid=$_codex_pid watcher_pid=$_watcher_pid"
}

# Always read session/cwd from hook JSON when stdin is piped.
HOOK_JSON=""
SESSION_SHORT=""
PROJECT_CWD=""
if [ ! -t 0 ]; then
    HOOK_JSON=$(cat)
    # 1) Codex: 从 transcript_path 文件名提取 UUID（rollout-...-<uuid>.jsonl）
    #    approval-hook.js 用同一套算法，保证审批态与通知态复用同一便签窗口。
    #    Claude Code 的 transcript_path 不匹配 rollout- 前缀 → 走下方 session_id 回退，CC 零影响。
    _transcript=$(json_get_string transcript_path 2>/dev/null || true)
    if [ -n "$_transcript" ]; then
        _tname=$(printf '%s' "$_transcript" | sed 's|\\|/|g' | sed 's|.*/||')
        _uuid=$(printf '%s' "$_tname" | sed -nE 's/^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/\1/p')
        if [ -n "$_uuid" ]; then
            SESSION_SHORT=$(printf '%s' "$_uuid" | tr -cd '[:alnum:]' | cut -c 1-16)
        fi
    fi
    # 2) 回退：session_id / sessionId / turn_id / turnId
    if [ -z "$SESSION_SHORT" ]; then
        for _session_key in session_id sessionId turn_id turnId; do
            _session_value=$(json_get_string "$_session_key" 2>/dev/null || true)
            if [ -n "$_session_value" ]; then
                SESSION_SHORT=$(printf '%s' "$_session_value" | tr -cd '[:alnum:]' | cut -c 1-16)
                break
            fi
        done
    fi
    PROJECT_CWD=$(json_get_string cwd 2>/dev/null || true)
fi

SESSION_KEY="${SESSION_KEY_OVERRIDE:-${SESSION_SHORT:-default}}"
STATE_KEY="${PROVIDER}-${SESSION_KEY}"
PROJECT=$(resolve_project_label)

# ── Logging ──────────────────────────────────────────────────────────────────
# Record every invocation to ~/.cc-notify/notify.log for debugging.
# Log entry is written as early as possible so even crashes leave a trace.
# Auto-rotate: when log exceeds ~512KB, rename to .log.1 (keep one backup).
LOG_FILE="$HOME/.cc-notify/notify.log"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
if [ -f "$LOG_FILE" ]; then
    _sz=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
    [ "$_sz" -gt 524288 ] 2>/dev/null && mv -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null
fi
_log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${STATE_KEY:-?}" "$*" >> "$LOG_FILE" 2>/dev/null; }
_log "INVOKE args=[$*] pwd=$(pwd)"

# Load user config (env.sh generated by `ccn set`, exports CC_STICKY_NOTIFY_CLOSE_TIMEOUT etc.)
# shellcheck disable=SC1091
[ -f "$SKILL_SCRIPTS/env.sh" ] && source "$SKILL_SCRIPTS/env.sh"

_log "SESSION provider=$PROVIDER key=$SESSION_KEY urgent=$URGENT force=$FORCE state=$STATE mode=$([ $# -gt 0 ] && echo 'arg' || echo 'stdin')"

# ── Close state: session ended, kill the sticky note and clean up ──────────────
if [ "$STATE" = "close" ]; then
    TMP_DIR="/tmp/cc-notify"
    CONTENT_FILE="$TMP_DIR/${STATE_KEY}.txt"
    PID_FILE="$TMP_DIR/${STATE_KEY}.pid"

    if [ -f "$PID_FILE" ]; then
        _existing_pid=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$_existing_pid" ] && kill -0 "$_existing_pid" 2>/dev/null; then
            kill "$_existing_pid" 2>/dev/null || true
            _log "CLOSE killed pid=$_existing_pid"
        fi
        rm -f "$PID_FILE" 2>/dev/null
    fi

    # Clean up all temp files for this session
    rm -f "$CONTENT_FILE" \
          "$TMP_DIR/${STATE_KEY}.sig" \
          "$TMP_DIR/${STATE_KEY}.focus" \
          "$TMP_DIR/${STATE_KEY}.window" \
          "$TMP_DIR/${STATE_KEY}.pos" \
          "$TMP_DIR/${STATE_KEY}.wid" \
          "$TMP_DIR/${STATE_KEY}.project" \
          "$TMP_DIR/${STATE_KEY}.slot" \
          "$TMP_DIR/${STATE_KEY}.watcher" \
          "$TMP_DIR/${STATE_KEY}.ghostty-tid" \
          "$TMP_DIR/${STATE_KEY}.ghostty-tty" \
          2>/dev/null
    _log "CLOSE cleaned up temp files"
    exit 0
fi

# Codex has no SessionEnd hook; start a watcher to close the note when the
# Codex process exits. No-op for Claude Code (it has a real SessionEnd hook).
ensure_codex_watcher

if [ $# -gt 0 ]; then
    # Arg mode: use __STATE__ marker (extra args after --state are ignored for content)
    LINES=("__STATE__:${STATE}" "Time: $TIMESTAMP")
else
    # Stdin mode: Stop hook — state already defaults to completed
    LINES=("__STATE__:${STATE}" "Time: $TIMESTAMP")
fi

# One window per provider session — use STATE_KEY so cd mid-session doesn't change the path
# PROJECT is used for display only (updated on every notification)
TMP_DIR="/tmp/cc-notify"
mkdir -p "$TMP_DIR"
CONTENT_FILE="$TMP_DIR/${STATE_KEY}.txt"
PID_FILE="$TMP_DIR/${STATE_KEY}.pid"
FOCUS_FILE="$TMP_DIR/${STATE_KEY}.focus"

# Walk process tree (pure ps calls, fast, synchronous)
_pid=$$
_ancestors=""
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    _pid=$(ps -p "$_pid" -o ppid= 2>/dev/null | tr -d ' ')
    if [ -z "$_pid" ] || [ "$_pid" = "0" ] || [ "$_pid" = "1" ]; then break; fi
    _ancestors="${_ancestors:+$_ancestors,}$_pid"
done

# Detect parent GUI app and front window via System Events (synchronous single call)
SOURCE_APP=""
if [ -n "$_ancestors" ]; then
    _wf="${FOCUS_FILE%.focus}.window"
    _posf="${FOCUS_FILE%.focus}.pos"
    _result=$(osascript -e "tell application \"System Events\"
set pids to {$_ancestors}
repeat with p in pids
    try
        set proc to first application process whose unix id is p
        if (background only of proc) is false and (bundle identifier of proc) is not missing value then
            set _n to name of proc
            set _w to \"\"
            set _px to \"\"
            set _py to \"\"
            try
                -- Prefer the window whose title starts with the project name.
                -- This correctly identifies the target IDEA/editor window when
                -- multiple windows of the same app are open for different projects.
                set _proj to "$PROJECT"
                set _projLen to length of _proj
                set _matched to missing value
                try
                    repeat with _wi in (windows of proc)
                        try
                            set _wname to name of _wi
                            if _projLen > 0 and length of _wname >= _projLen and text 1 thru _projLen of _wname is equal to _proj then
                                set _matched to _wi
                                exit repeat
                            end if
                        end try
                    end repeat
                end try
                -- Fallback to front window when no project-name match found
                if _matched is missing value then
                    try
                        set _matched to front window of proc
                    end try
                end if
                if _matched is not missing value then
                    set _w to name of _matched
                    set _pos to position of _matched
                    set _px to (item 1 of _pos) as text
                    set _py to (item 2 of _pos) as text
                end if
            end try
            return _n & \"|\" & _w & \"|\" & _px & \",\" & _py
        end if
    end try
end repeat
end tell" 2>/dev/null)
    if [ -n "$_result" ]; then
        SOURCE_APP=$(printf '%s' "${_result%%|*}" | tr -d '\r\n')
        _rest="${_result#*|}"
        _win=$(printf '%s' "${_rest%%|*}" | tr -d '\r\n')
        _pos=$(printf '%s' "${_rest#*|}" | tr -d '\r\n')
        [ -n "$SOURCE_APP" ] && printf '%s\n' "$SOURCE_APP" > "$FOCUS_FILE"
        # Window title and position written only once (first notification wins):
        # Prevents later hooks (e.g. Stop) from overwriting the original target window
        # if the user has switched to a different window in the meantime.
        [ -n "$_win" ] && [ ! -f "$_wf" ] && printf '%s\n' "$_win" > "$_wf"
        [[ "$_pos" == *,* ]] && [ ! -f "$_posf" ] && printf '%s\n' "$_pos" > "$_posf"
        # Capture CGWindowID — unique per window, reliable for multi-window matching
        _widFile="$TMP_DIR/${STATE_KEY}.wid"
        if [ ! -f "$_widFile" ]; then
            # Prefer the window whose title starts with $PROJECT (handles multiple windows
            # of the same app open for different projects). Falls back to the frontmost window.
            _wid=$(osascript -l JavaScript -e "
ObjC.import('CoreGraphics');ObjC.import('Foundation');
var target='$SOURCE_APP'.toLowerCase();
var project='$(printf '%s' "$PROJECT" | sed "s/'/\\\\'/g")';
var cfArr=\$.CGWindowListCopyWindowInfo(1,0);
var nsArr=ObjC.castRefToObject(cfArr);var r='',fallback='';
for(var i=0;i<nsArr.count;i++){var info=nsArr.objectAtIndex(i);
var owner=ObjC.unwrap(info.objectForKey('kCGWindowOwnerName'));
if(owner&&owner.toLowerCase()===target&&ObjC.unwrap(info.objectForKey('kCGWindowLayer'))===0){
var wid=''+ObjC.unwrap(info.objectForKey('kCGWindowNumber'));
var name=ObjC.unwrap(info.objectForKey('kCGWindowName'))||'';
if(project&&(name===project||name.indexOf(project+' ')===0||name.indexOf(project+'\u2013')===0||name.indexOf(project+' \u2013')===0)){r=wid;break;}
if(!fallback){fallback=wid;}}}r||fallback;" 2>/dev/null)
            [ -n "$_wid" ] && printf '%s\n' "$_wid" > "$_widFile"
        fi
    fi
fi

# ── Ghostty: capture terminal ID + TTY for surface-level precise focus ─────
# terminal ID uniquely identifies each split/tab surface; TTY is the fallback
# match key for the whose-clause in Ghostty AppleScript (tty property can't be
# coerced to text directly, so ID is captured via AS and TTY via ps on the
# shell process that sits right before ghostty in the pid chain).
if [ "$SOURCE_APP" = "ghostty" ] || [ "$SOURCE_APP" = "Ghostty" ]; then
    GHOSTTY_TID_FILE="$TMP_DIR/${STATE_KEY}.ghostty-tid"
    GHOSTTY_TTY_FILE="$TMP_DIR/${STATE_KEY}.ghostty-tty"
    if [ ! -f "$GHOSTTY_TID_FILE" ]; then
        # Capture terminal ID
        _tid=$(osascript -e \
            'tell application "Ghostty" to return id of focused terminal of selected tab of front window' \
            2>/dev/null)
        [ -n "$_tid" ] && printf '%s\n' "$_tid" > "$GHOSTTY_TID_FILE"

        # Walk pid chain to find the shell TTY (pid right before ghostty)
        _prev=""
        IFS=',' read -ra _pid_arr <<< "$_ancestors"
        for _p in "${_pid_arr[@]}"; do
            _comm=$(ps -p "$_p" -o comm= 2>/dev/null | sed 's|.*/||' | tr -d ' ')
            case "$_comm" in
                ghostty|Ghostty)
                    if [ -n "$_prev" ]; then
                        _tty=$(ps -p "$_prev" -o tty= 2>/dev/null | tr -d ' ')
                        [ -n "$_tty" ] && printf '%s\n' "$_tty" > "$GHOSTTY_TTY_FILE"
                    fi
                    break
                    ;;
            esac
            _prev="$_p"
        done
        _log "GHOSTTY tid=$_tid tty=$_tty"
    fi
fi

# Append Source (Time → Source → Project order)
[ -n "$SOURCE_APP" ] && LINES+=("Source: $SOURCE_APP")
LINES+=("Project: $PROJECT")

# Dedup: compute content signature excluding the Time: line
SIG=""
for _line in "${LINES[@]}"; do
    [[ "$_line" == Time:* ]] && continue
    SIG="${SIG}${_line}\n"
done
LAST_SIG_FILE="$TMP_DIR/${STATE_KEY}.sig"
if [ "$FORCE" != "1" ]; then
    if [ -f "$LAST_SIG_FILE" ]; then
        PREV_SIG=$(cat "$LAST_SIG_FILE" 2>/dev/null)
        if [ "$PREV_SIG" = "$SIG" ]; then
            _log "DEDUP_SKIP sig unchanged"
            exit 0  # Same content as last notification, skip
        fi
    fi
fi
printf '%s' "$SIG" > "$LAST_SIG_FILE"
_log "CONTENT_WRITE urgent=$URGENT state=$STATE"

# Guard: if the content file is already in __APPROVAL__ mode (written by
# approval-server.js), don't overwrite it — UNLESS the current state is
# "completed" (Stop hook) or "working" (subsequent hook after terminal approval).
#
# Background: when the user approves in the terminal instead of clicking the
# sticky note buttons, Claude Code kills the approval-hook.js process and
# continues the task.  The next time notify.sh is called (Stop hook or any
# subsequent event), the content file still has __APPROVAL__ from before.
# Allowing completed/working states to overwrite __APPROVAL__ lets the sticky
# note recover from the stale approval mode and display the real current state.
#
# Urgent/approval states still respect the guard: the Notification hook
# (--urgent) fires in parallel with the PermissionRequest hook, and the
# approval flow (interactive buttons) takes priority in that case.
if [ -f "$CONTENT_FILE" ]; then
    _first_line=$(head -n 1 "$CONTENT_FILE" 2>/dev/null || true)
    if [ "$_first_line" = "__APPROVAL__" ]; then
        if [ "$STATE" = "completed" ] || [ "$STATE" = "working" ]; then
            _log "OVERRIDE_APPROVAL state=$STATE (terminal approval detected, restoring sticky note)"
        else
            _log "SKIP_APPROVAL_ACTIVE (approval mode in progress, won't overwrite)"
            exit 0
        fi
    fi
fi

if [ "$URGENT" = "1" ]; then
    { printf '__URGENT__\n'; printf '%s\n' "${LINES[@]}"; } > "$CONTENT_FILE"
else
    printf '%s\n' "${LINES[@]}" > "$CONTENT_FILE"
fi

if [ -f "$PID_FILE" ]; then
    EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
        _log "PID_REUSE pid=$EXISTING_PID (window alive, DispatchSource refresh)"
        exit 0  # Window is alive; DispatchSource watcher refreshes content automatically
    fi
    _log "PID_STALE pid=$EXISTING_PID (process dead, will launch new)"
fi

# No running instance — launch new floating sticky note
if [ -f "$BINARY" ]; then
    "$BINARY" "$CONTENT_FILE" </dev/null >/dev/null 2>&1 &
    _log "LAUNCH pid=$! binary=$BINARY"
    disown $!
else
    _log "ERROR binary not found: $BINARY"
fi
