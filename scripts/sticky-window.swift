// cc-sticky-notify — native macOS floating sticky note
// CLI arg: path to a content file (one line per notification line)
// Build: swiftc sticky-window.swift -o sticky-notify-app
// Usage: ./sticky-notify-app /tmp/cc-sticky-notify-myproject.txt

import Cocoa
import ApplicationServices

// Private API: get CGWindowID from an AXUIElement window
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

class StickyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// Label subclass that passes mouse events through to the parent card view.
// NSTextField normally consumes mouseDown/mouseUp, blocking the card tap.
class PassthroughLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// NSTextView subclass for meta area: supports mixed-color attributed strings,
// passes all mouse events through to the parent card view.
class PassthroughTextView: NSTextView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }
}

// Clickable accent bar: amber = following all Spaces, slate-blue = pinned to current Space.
class AccentBarView: NSView {
    var isFollowing: Bool = false { didSet { refresh() } }
    var onToggle: ((Bool) -> Void)?
    var followColor = NSColor(calibratedRed: 0.95, green: 0.62, blue: 0.12, alpha: 1.0)
    var pinnedColor = NSColor(calibratedRed: 0.45, green: 0.55, blue: 0.70, alpha: 1.0)
    var currentColor: NSColor { isFollowing ? followColor : pinnedColor }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func refresh() {
        layer?.backgroundColor = (isFollowing ? followColor : pinnedColor).cgColor
        toolTip = isFollowing
            ? "Following all Spaces — click to pin to current Space"
            : "Pinned to this Space — click to follow to all Spaces"
    }

    override func mouseDown(with event: NSEvent) {
        isFollowing.toggle()
        onToggle?(isFollowing)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

// Custom card view: tracks mouseDown/mouseUp to detect a tap (not drag)
// without interfering with subview buttons or the window's move-by-background.
class StickyCardView: NSView {
    var closeBtnFrame: NSRect = .zero
    var contentFrame: NSRect = .zero   // only taps inside this area trigger focus
    var onTap: (() -> Void)?
    // Use screen-coordinates so that window-drag (isMovableByWindowBackground)
    // doesn't fool the tap detector: when the window tracks the mouse the
    // window-local position stays near-zero even during a real drag.
    private var mouseDownScreenPt: NSPoint = .zero

    // ── Hover tooltip (custom, activeAlways — standard addToolTip won't fire
    //    for orderFrontRegardless accessory windows) ─────────────────────────
    // Array of (rect-in-cardView-coords, full-text) pairs set by AppDelegate.
    var tooltipZones: [(rect: NSRect, text: String)] = [] {
        didSet { needsToUpdateTrackingAreas() }
    }
    private var tooltipPanel: NSPanel?
    private var tooltipTimer: Timer?

    private func needsToUpdateTrackingAreas() {
        // Remove old tracking areas (keep any non-tooltip ones if added later)
        for ta in trackingAreas { removeTrackingArea(ta) }
        guard !tooltipZones.isEmpty else { return }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways],
            owner: self, userInfo: nil))
    }

    override func mouseMoved(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        if let zone = tooltipZones.first(where: { $0.rect.contains(pt) }) {
            scheduleTooltip(zone.text, locationInWindow: event.locationInWindow)
        } else {
            hideTooltip()
        }
    }

    override func mouseExited(with event: NSEvent) { hideTooltip() }

    private func scheduleTooltip(_ text: String, locationInWindow loc: NSPoint) {
        // Already showing the same tooltip — nothing to do
        if let p = tooltipPanel, p.isVisible, (p.contentView?.subviews.first as? NSTextField)?.stringValue == text { return }
        tooltipTimer?.invalidate()
        tooltipTimer = Timer.scheduledTimer(withTimeInterval: 0.55, repeats: false) { [weak self] _ in
            self?.showTooltip(text, locationInWindow: loc)
        }
    }

    func showTooltip(_ text: String, locationInWindow loc: NSPoint) {
        hideTooltip()
        guard let parentWindow = window else { return }

        let font  = NSFont.systemFont(ofSize: 11.5)
        let attrs: [NSAttributedString.Key: Any] = [.font: font]
        let pad:  CGFloat = 5
        let raw   = (text as NSString).size(withAttributes: attrs)
        let panelW = raw.width + pad * 2 + 2
        let panelH = raw.height + pad * 2

        // Position below cursor; flip above if too close to bottom of screen,
        // flip left if too close to right edge of screen
        var origin = parentWindow.convertToScreen(
            NSRect(x: loc.x + 2, y: loc.y - panelH - 8, width: 0, height: 0)).origin
        if let screen = parentWindow.screen {
            if origin.y < screen.visibleFrame.minY {
                origin.y = parentWindow.convertToScreen(
                    NSRect(x: loc.x + 2, y: loc.y + 14, width: 0, height: 0)).origin.y
            }
            if origin.x + panelW > screen.visibleFrame.maxX {
                origin.x = parentWindow.convertToScreen(
                    NSRect(x: loc.x - panelW - 4, y: 0, width: 0, height: 0)).origin.x
            }
        }

        let panel = NSPanel(
            contentRect: NSRect(x: origin.x, y: origin.y, width: panelW, height: panelH),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.level          = .popUpMenu   // above floating sticky note
        panel.isOpaque       = false
        panel.backgroundColor = .clear
        panel.hasShadow      = true
        panel.isReleasedWhenClosed = false

        let bg = NSView(frame: NSRect(x: 0, y: 0, width: panelW, height: panelH))
        bg.wantsLayer = true
        bg.layer?.backgroundColor = NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.78, alpha: 0.97).cgColor
        bg.layer?.cornerRadius    = 4
        bg.layer?.borderWidth     = 0.5
        bg.layer?.borderColor     = NSColor(calibratedRed: 0.75, green: 0.65, blue: 0.30, alpha: 0.8).cgColor
        panel.contentView = bg

        let lbl = NSTextField(labelWithString: text)
        lbl.frame               = NSRect(x: pad, y: pad, width: panelW - pad * 2, height: raw.height)
        lbl.font                = font
        lbl.textColor           = NSColor(calibratedRed: 0.12, green: 0.07, blue: 0.0, alpha: 1.0)
        lbl.lineBreakMode       = .byClipping
        lbl.drawsBackground     = false
        lbl.isBordered          = false
        bg.addSubview(lbl)

        panel.orderFrontRegardless()
        tooltipPanel = panel
    }

    func hideTooltip() {
        tooltipTimer?.invalidate()
        tooltipTimer = nil
        tooltipPanel?.close()
        tooltipPanel = nil
    }

    // ── Tap detection ───────────────────────────────────────────────────────
    override func mouseDown(with event: NSEvent) {
        // Record position in screen coordinates so that window-drag
        // (isMovableByWindowBackground) doesn't zero-out the delta:
        // when the window follows the mouse the window-local position
        // stays near-constant, making every drag look like a tap.
        mouseDownScreenPt = NSEvent.mouseLocation
        super.mouseDown(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        let screenPt = NSEvent.mouseLocation
        let dist = hypot(screenPt.x - mouseDownScreenPt.x,
                         screenPt.y - mouseDownScreenPt.y)
        let localPt = convert(event.locationInWindow, from: nil)
        if dist < 5 && !closeBtnFrame.contains(localPt) && contentFrame.contains(localPt) {
            onTap?()
        }
        super.mouseUp(with: event)
    }

    // Accept the first mouse-down even when the window is not key,
    // so a single click triggers the tap without first activating the window.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// Right-edge drag handle — lets the user resize the card width.
// Anchors the RIGHT edge of the window; dragging leftward makes it wider.
class ResizeHandleView: NSView {
    var onDrag: ((CGFloat) -> Void)?
    private var startScreenX: CGFloat = 0
    private var trackingArea: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let ta = trackingArea { removeTrackingArea(ta) }
        trackingArea = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self, userInfo: nil)
        addTrackingArea(trackingArea!)
    }

    override func mouseEntered(with event: NSEvent) {
        layer?.backgroundColor = NSColor(calibratedRed: 0.80, green: 0.65, blue: 0.25, alpha: 0.30).cgColor
    }
    override func mouseExited(with event: NSEvent) {
        layer?.backgroundColor = NSColor.clear.cgColor
    }
    override func mouseDown(with event: NSEvent) {
        startScreenX = NSEvent.mouseLocation.x
    }
    override func mouseDragged(with event: NSEvent) {
        let x = NSEvent.mouseLocation.x
        onDrag?(x - startScreenX)
        startScreenX = x
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: StickyWindow!
    let contentFilePath: String
    let pidFilePath: String
    var fileWatchSource: DispatchSourceFileSystemObject?
    var watchedInode: UInt64 = 0          // inode when DispatchSource was created
    var inodeCheckTimer: Timer?           // periodic fallback to detect inode changes
    var headerLabel: PassthroughLabel!
    var metaLineLabels: [PassthroughLabel] = []
    var focusFilePath: String
    var windowFilePath: String
    var posFilePath: String
    var widFilePath: String
    var closeBtn: NSButton!
    var collapseBtn: NSButton!
    var accentBar: AccentBarView!
    var slotFilePath: String
    var cardView: StickyCardView!
    // Overlay label shown in the center of the circle when collapsed
    var iconLabel: PassthroughLabel?
    var isCollapsed = false
    var isUrgent = false   // true when content starts with __URGENT__
    var storedMetaLines: [String] = []
    var noteW: CGFloat = 190
    let noteH: CGFloat = 80
    var dividerView: NSView!
    var resizeHandle: ResizeHandleView!
    // Auto-close timer: restarted on every content update
    var closeTimer: Timer?
    var closeTimeout: Double = 3600

    // ── Approval mode
    var isApproval = false
    var approvalData: [String: Any]?
    var approvalFilePath: String = ""
    var approvalButtons: [NSView] = []
    var approvalButtonsDisabled = false

    // ── Current state (working | completed | approval) ──────────────────────
    var currentState: String = "working"
    var lastNormalState: String = "working"   // last non-approval state (for restore)
    var contentLabel: PassthroughLabel!

    // ── Pre-approval state saved for restoration ────────────────────────────
    var preApprovalState: String = ""
    var preApprovalHeaderText: String = ""
    var preApprovalIsUrgent: Bool = false
    var preApprovalContentText: String = ""

    // ── Theme colors — switch on isUrgent ─────────────────────────────────
    var cardBgColor: NSColor {
        isUrgent
            ? NSColor(calibratedRed: 0.92, green: 0.16, blue: 0.14, alpha: 1.0)  // Apple red
            : NSColor(calibratedRed: 0.98, green: 0.96, blue: 0.72, alpha: 1.0)  // cream yellow
    }
    var headerTextColor: NSColor {
        isUrgent
            ? NSColor.white
            : NSColor(calibratedRed: 0.15, green: 0.10, blue: 0.0, alpha: 1.0)
    }
    var metaNormalColor: NSColor {
        isUrgent
            ? NSColor(calibratedRed: 1.0, green: 0.82, blue: 0.82, alpha: 1.0)  // light pink-white
            : NSColor(calibratedRed: 0.30, green: 0.20, blue: 0.05, alpha: 1.0)
    }
    var metaProjectValColor: NSColor {
        isUrgent
            ? NSColor.white
            : NSColor(calibratedRed: 0.82, green: 0.08, blue: 0.08, alpha: 1.0)
    }
    var accentFollowColor: NSColor {
        isUrgent
            ? NSColor(calibratedRed: 0.60, green: 0.04, blue: 0.04, alpha: 1.0)  // dark red
            : NSColor(calibratedRed: 0.95, green: 0.62, blue: 0.12, alpha: 1.0)  // amber
    }
    var accentPinnedColor: NSColor {
        isUrgent
            ? NSColor(calibratedRed: 0.45, green: 0.04, blue: 0.04, alpha: 1.0)  // deeper dark red
            : NSColor(calibratedRed: 0.45, green: 0.55, blue: 0.70, alpha: 1.0)  // slate-blue
    }
    var dividerColor: NSColor {
        isUrgent
            ? NSColor(calibratedRed: 0.70, green: 0.10, blue: 0.10, alpha: 0.8)
            : NSColor(calibratedRed: 0.85, green: 0.72, blue: 0.35, alpha: 0.7)
    }
    var closeBtnColor: NSColor {
        isUrgent
            ? NSColor(calibratedRed: 1.0, green: 0.75, blue: 0.75, alpha: 0.85)
            : NSColor(calibratedRed: 0.45, green: 0.35, blue: 0.15, alpha: 0.7)
    }

    init(contentFilePath: String) {
        self.contentFilePath = contentFilePath
        let base = contentFilePath.hasSuffix(".txt")
            ? String(contentFilePath.dropLast(4))
            : contentFilePath
        self.pidFilePath   = base + ".pid"
        self.focusFilePath = base + ".focus"
        self.windowFilePath = base + ".window"
        self.posFilePath   = base + ".pos"
        self.widFilePath   = base + ".wid"
        self.slotFilePath  = base + ".slot"
        self.approvalFilePath = base + ".approval.json"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // PID file is now written in main() before app.run() — see bottom of file.
        // This eliminates a race condition where concurrent processes
        // (notify.sh / approval-server.js) might launch duplicate windows
        // before applicationDidFinishLaunching has a chance to run.

        // NSScreen.screens[0] 始终是主屏幕（菜单栏所在屏幕），
        // 而 NSScreen.main 会随键盘焦点动态变化，不可靠
        guard let screen = NSScreen.screens.first else { NSApp.terminate(nil); return }

        let topOffset: CGFloat = 110   // distance from top of visibleFrame to first note
        let rightMargin: CGFloat = 12  // tighter to right edge
        let vis = screen.visibleFrame

        // slotStep = full window height + 8pt gap → windows never overlap
        let slotStep: CGFloat = noteH + 8
        // How many non-overlapping windows fit on this screen (account for topOffset)
        let maxNoCoverSlots = max(1, min(10, Int((vis.height - noteH - topOffset) / slotStep) + 1))
        let maxSlots = maxNoCoverSlots + 2  // overflow pool (always below main slots)
        var slot = 0

        var occupiedSlots = Set<Int>()
        // slotFilePath and pidFilePath both live in the same dir as the content file;
        // scan THAT directory so we actually find the slot files we write.
        let tmpDir = URL(fileURLWithPath: contentFilePath).deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        if let files = try? FileManager.default.contentsOfDirectory(at: tmpDir, includingPropertiesForKeys: nil) {
            for file in files
                where file.pathExtension == "slot" {
                let pidFile = file.deletingPathExtension().appendingPathExtension("pid")
                if let pidStr = try? String(contentsOf: pidFile, encoding: .utf8),
                   let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)),
                   kill(pid, 0) == 0,
                   let slotStr = try? String(contentsOf: file, encoding: .utf8),
                   let s = Int(slotStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    occupiedSlots.insert(s)
                }
            }
        }

        if occupiedSlots.count >= maxNoCoverSlots {
            // All non-overlap slots taken — overflow into slots >= maxNoCoverSlots only,
            // so new notes never cover existing visible notes.
            let cycleFile = tmpDir.appendingPathComponent("_slot_cycle").path
            var found = false
            for s in maxNoCoverSlots..<maxSlots where !occupiedSlots.contains(s) {
                slot = s
                found = true
                break
            }
            if !found {
                // Both overflow slots occupied — cycle within overflow range only
                var base = 0
                if let data = try? Data(contentsOf: URL(fileURLWithPath: cycleFile)),
                   let str = String(data: data, encoding: .utf8),
                   let n = Int(str.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    base = n
                }
                let overflowCount = maxSlots - maxNoCoverSlots  // always 2
                slot = maxNoCoverSlots + (base % overflowCount)
                try? String(base + 1).write(toFile: cycleFile, atomically: true, encoding: .utf8)
            }
        } else {
            // Pick the lowest unoccupied slot in 0..<maxNoCoverSlots
            for s in 0..<maxNoCoverSlots where !occupiedSlots.contains(s) {
                slot = s
                break
            }
        }
        try? String(slot).write(toFile: slotFilePath, atomically: true, encoding: .utf8)

        let x = vis.maxX - noteW - rightMargin
        let y = vis.maxY - noteH - topOffset - CGFloat(slot) * slotStep

        // 必须传入 screen 参数，否则 macOS 会忽略 contentRect 的坐标，
        // 将窗口放到鼠标当前所在屏幕
        window = StickyWindow(
            contentRect: NSRect(x: x, y: y, width: noteW, height: noteH),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        window.level = .floating
        window.isReleasedWhenClosed = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.collectionBehavior = []  // default: pinned to current Space

        // Card view: rounded corners + warm cream-yellow background
        cardView = StickyCardView(frame: NSRect(x: 0, y: 0, width: noteW, height: noteH))
        cardView.wantsLayer = true
        cardView.layer?.cornerRadius = 12
        cardView.layer?.masksToBounds = true
        window.contentView = cardView

        // Left accent bar: amber when following all Spaces, slate-blue when pinned
        accentBar = AccentBarView(frame: NSRect(x: 0, y: 0, width: 5, height: noteH))
        accentBar.onToggle = { [weak self] isFollowing in
            self?.window.collectionBehavior = isFollowing ? .canJoinAllSpaces : []
        }
        cardView.addSubview(accentBar)

        let rowY: CGFloat = noteH - 28

        // Header label: 13pt semibold, dark brown (same row as close/collapse buttons)
        headerLabel = PassthroughLabel(labelWithString: "")
        headerLabel.frame = NSRect(x: 16, y: rowY, width: noteW - 64, height: 20)
        headerLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        headerLabel.textColor = .clear   // set by applyTheme() after isUrgent is known
        headerLabel.lineBreakMode = .byTruncatingTail
        cardView.addSubview(headerLabel)

        // Collapse button (▾, second from right in header row)
        collapseBtn = NSButton(frame: NSRect(x: noteW - 48, y: rowY + 1, width: 18, height: 18))
        collapseBtn.attributedTitle = NSAttributedString(string: "▾", attributes: [
            .foregroundColor: NSColor.clear,   // set by applyTheme()
            .font: NSFont.systemFont(ofSize: 11, weight: .medium)
        ])
        collapseBtn.isBordered = false
        collapseBtn.target = self
        collapseBtn.action = #selector(collapseWindowAction)
        cardView.addSubview(collapseBtn)

        // Close button (top-right ✕, same row as header)
        closeBtn = NSButton(frame: NSRect(x: noteW - 26, y: rowY, width: 20, height: 20))
        closeBtn.attributedTitle = NSAttributedString(string: "✕", attributes: [
            .foregroundColor: NSColor.clear,   // set by applyTheme()
            .font: NSFont.systemFont(ofSize: 12, weight: .medium)
        ])
        closeBtn.isBordered = false
        closeBtn.target = NSApp
        closeBtn.action = #selector(NSApplication.terminate(_:))
        cardView.addSubview(closeBtn)

        // Divider line: color set by applyTheme()
        dividerView = NSView(frame: NSRect(x: 16, y: rowY - 4, width: noteW - 24, height: 1))
        dividerView.wantsLayer = true
        dividerView.layer?.backgroundColor = NSColor.clear.cgColor
        cardView.addSubview(dividerView)

        // Content label — single line showing status text (hidden during approval)
        contentLabel = PassthroughLabel(labelWithString: "")
        contentLabel.frame = NSRect(x: 16, y: 12, width: noteW - 24, height: 24)
        contentLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        contentLabel.textColor = .clear   // set by applyTheme()
        contentLabel.alignment = .center
        contentLabel.lineBreakMode = .byTruncatingTail
        cardView.addSubview(contentLabel)

        // Right-edge resize handle (meta area only, avoids header buttons)
        resizeHandle = ResizeHandleView(
            frame: NSRect(x: noteW - 4, y: 0, width: 4, height: rowY - 4))
        resizeHandle.onDrag = { [weak self] delta in
            guard let self = self else { return }
            let minW: CGFloat = 180
            let maxW: CGFloat = 600
            let newW = max(minW, min(maxW, self.noteW - delta))
            guard abs(newW - self.noteW) > 0.5 else { return }
            self.noteW = newW
            self.relayout()
        }
        cardView.addSubview(resizeHandle)

        // Load initial content — reloadContent() handles both __URGENT__ and
        // __APPROVAL__ modes.  Important when the sticky note was closed earlier
        // in the session and a new approval request triggers a fresh Swift process:
        // the content file already has __APPROVAL__ at launch time.
        reloadContent()

        // Watch content file for in-place updates when notify.sh writes new content.
        // setupFileWatcher() also handles inode changes (atomic writes that replace the file).
        setupFileWatcher()

        // Periodic fallback: stat() the file every 5s to catch inode changes that
        // the DispatchSource might miss (e.g. if .delete/.rename events don't fire
        // reliably on all macOS versions).
        inodeCheckTimer = Timer.scheduledTimer(
            timeInterval: 5.0, target: self,
            selector: #selector(checkInodeChanged),
            userInfo: nil, repeats: true)

        // Tap behaviour: expand when collapsed, or focus terminal when expanded.
        // Urgent theme persists until the next event overwrites the content.
        cardView.closeBtnFrame = closeBtn.frame
        cardView.contentFrame = NSRect(x: 16, y: 8, width: noteW - 24, height: noteH - 16)
        cardView.onTap = { [weak self] in
            guard let self = self else { return }
            if self.isCollapsed { self.expandWindow() } else { self.focusTerminal() }
        }

        // orderFrontRegardless 不激活 App，避免系统因焦点变化重新定位窗口
        window.orderFrontRegardless()

        // Auto-close: default 1 hour; override with CC_STICKY_NOTIFY_CLOSE_TIMEOUT env var (seconds).
        // The timer is reset on every content update — the window only closes after the configured
        // idle duration has elapsed with no new notifications.
        if let envVal = ProcessInfo.processInfo.environment["CC_STICKY_NOTIFY_CLOSE_TIMEOUT"],
           let seconds = Double(envVal), seconds > 0 {
            closeTimeout = seconds
        } else {
            closeTimeout = 3600
        }
        scheduleCloseTimer()
    }

    // Collapse: hide card content, show circle icon, shrink window.
    // Hide any visible tooltip first.
    // Keeps cardView as contentView — avoids borderless-window contentView-swap bugs.
    @objc func collapseWindowAction() {
        guard !isCollapsed else { return }
        isCollapsed = true
        cardView.hideTooltip()

        let circleSize: CGFloat = 44

        // Create a centred icon label and add it on top of cardView.
        // sizeToFit() gives the natural text size; we then place it at the circle centre.
        let icon = PassthroughLabel(labelWithString: extractIcon(from: headerLabel.stringValue))
        icon.font = NSFont.systemFont(ofSize: 22)
        icon.drawsBackground = false
        icon.isBordered = false
        icon.sizeToFit()
        let lw = max(icon.frame.width, 28), lh = max(icon.frame.height, 28)
        icon.frame = NSRect(x: (circleSize - lw) / 2, y: (circleSize - lh) / 2,
                            width: lw, height: lh)
        iconLabel = icon
        cardView.addSubview(icon)

        // Hide every other subview
        for sub in cardView.subviews where sub !== icon {
            sub.isHidden = true
        }

        // Reshape cardView layer into a circle with a coloured ring
        cardView.layer?.cornerRadius = circleSize / 2
        cardView.layer?.borderWidth = 2.5
        cardView.layer?.borderColor = accentBar.currentColor.cgColor

        // Expand tap zone to the whole circle; no close button to exclude
        cardView.closeBtnFrame = .zero
        cardView.contentFrame  = NSRect(x: 0, y: 0, width: circleSize, height: circleSize)

        // Shrink window, anchoring at the top-right corner of the original card
        let cur = window.frame
        window.setFrame(
            NSRect(x: cur.maxX - circleSize, y: cur.maxY - circleSize,
                   width: circleSize, height: circleSize),
            display: true, animate: false)

        // Set project name tooltip on the circle
        updateTooltips()
    }

    // Expand: restore card subviews and resize window back to full card.
    func expandWindow() {
        guard isCollapsed else { return }
        isCollapsed = false

        // Remove icon overlay and un-hide original subviews
        iconLabel?.removeFromSuperview()
        iconLabel = nil
        for sub in cardView.subviews {
            sub.isHidden = false
        }

        // In approval mode, the content label must stay hidden — the buttons
        // replace it.  Also re-hide any stale meta line labels.
        if isApproval {
            contentLabel.isHidden = true
            for lbl in metaLineLabels { lbl.isHidden = true }
        }

        // Restore cardView layer to rounded-rect card
        cardView.layer?.cornerRadius = 12
        cardView.layer?.borderWidth = 0

        // Restore tap detection
        cardView.closeBtnFrame = closeBtn.frame
        cardView.contentFrame = NSRect(x: 16, y: 8, width: noteW - 24, height: noteH - 16)

        // Expand window, anchoring at the top-right corner of the collapsed circle
        let cur = window.frame
        window.setFrame(
            NSRect(x: cur.maxX - noteW, y: cur.maxY - noteH,
                   width: noteW, height: noteH),
            display: true, animate: false)
        updateTooltips()
    }

    // Return the first grapheme cluster (emoji or character) from the header.
    func extractIcon(from text: String) -> String {
        guard let first = text.first else { return "📌" }
        return String(first)
    }

    // 剥离标题前导符号（⠂✳⠐ 等各种 spinner/icon），保留字母或数字起始的核心标题
    func stripTitlePrefix(_ s: String) -> String {
        var result = s
        while let first = result.unicodeScalars.first,
              !first.properties.isAlphabetic,
              !(first.value >= 0x30 && first.value <= 0x39) {
            result = String(result.unicodeScalars.dropFirst())
        }
        return result.trimmingCharacters(in: .whitespaces)
    }

    // ── State → icon / status text mappings (hardcoded) ─────────────────
    func iconForState(_ state: String) -> String {
        switch state {
        case "working":   return "⏳"
        case "completed": return "✅"
        case "approval":  return "🔐"
        default:          return "📌"
        }
    }

    func statusTextForState(_ state: String) -> String {
        switch state {
        case "working":   return "Working…"
        case "completed": return "Completed"
        case "approval":  return "Permission Required"
        default:          return "Active"
        }
    }

    func debugLog(_ msg: String) {
        let path = "/tmp/cc-sticky-notify/focus-debug.log"
        let ts = ISO8601DateFormatter().string(from: Date())
        let line = "[\(ts)] \(msg)\n"
        if let h = FileHandle(forWritingAtPath: path) {
            h.seekToEndOfFile(); h.write(line.data(using: .utf8) ?? Data()); h.closeFile()
        } else { try? line.write(toFile: path, atomically: true, encoding: .utf8) }
    }

    func raiseWindow(_ window: AXUIElement, app: NSRunningApplication, axApp: AXUIElement) {
        // 1) 先激活 app（让它成为前台应用）
        app.activate(options: [])
        // 2) 设置为 main window
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        // 3) Raise 动作
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        // 4) 延迟再次 raise（确保 activate 完成后 raise 生效）
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        }
    }

    func postDecision(_ decision: String, message: String? = nil) {
        guard let endpoint = approvalData?["decisionEndpoint"] as? String,
              let requestId = approvalData?["requestId"] as? String,
              !approvalButtonsDisabled else { return }
        approvalButtonsDisabled = true
        for v in approvalButtons { v.alphaValue = 0.4 }
        guard let url = URL(string: endpoint) else { return }
        var body: [String: String] = ["requestId": requestId, "decision": decision]
        if let msg = message { body["message"] = msg }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 10
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let task = URLSession.shared.dataTask(with: req) { [weak self] data, resp, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let httpResp = resp as? HTTPURLResponse {
                    if httpResp.statusCode == 200 {
                        self.exitApprovalMode(restoreSaved: true)
                    } else if httpResp.statusCode == 409 {
                        self.exitApprovalMode(restoreSaved: true)
                    } else if httpResp.statusCode == 404 {
                        self.exitApprovalMode(restoreSaved: true)
                    } else {
                        self.cardView?.showTooltip("Error: \(httpResp.statusCode)", locationInWindow: NSPoint(x: 50, y: 30))
                    }
                } else if error != nil {
                    if self.approvalButtonsDisabled {
                        self.approvalButtonsDisabled = false
                        for v in self.approvalButtons { v.alphaValue = 1.0 }
                    }
                    self.cardView?.showTooltip("Network error — try again", locationInWindow: NSPoint(x: 50, y: 30))
                }
            }
        }
        task.resume()
    }

    @objc func approvalAllowAction(_ sender: Any? = nil)  { guard !approvalButtonsDisabled else { return }; postDecision("allow") }
    @objc func approvalDenyAction(_ sender: Any? = nil)   { guard !approvalButtonsDisabled else { return }; postDecision("deny", message: "Denied from sticky note") }
    @objc func approvalAlwaysAction(_ sender: Any? = nil)  { guard !approvalButtonsDisabled else { return }; postDecision("allow_always") }
    @objc func approvalFocusAction(_ sender: Any? = nil)  { guard !approvalButtonsDisabled else { return }; focusTerminal() }

    func focusTerminal() {
        debugLog("--- focusTerminal called ---")
        guard let raw = try? String(contentsOfFile: focusFilePath, encoding: .utf8) else {
            debugLog("FAIL: cannot read .focus file"); return
        }
        let appName = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !appName.isEmpty else { debugLog("FAIL: appName empty"); return }
        debugLog("appName=\(appName)")

        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            $0.executableURL?.lastPathComponent == appName || $0.localizedName == appName
        }) else { debugLog("FAIL: app not found"); return }
        debugLog("app found pid=\(app.processIdentifier)")

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let windows = windowsRef as? [AXUIElement] else {
            debugLog("FAIL: cannot get AX windows, fallback activate")
            app.activate(options: []); return
        }
        debugLog("AX windows count=\(windows.count)")

        // 策略 0：CGWindowID 精确匹配（最可靠，每个窗口唯一）
        let savedWID: CGWindowID? = {
            guard let s = try? String(contentsOfFile: widFilePath, encoding: .utf8) else { return nil }
            return CGWindowID(s.trimmingCharacters(in: .whitespacesAndNewlines))
        }()
        debugLog("savedWID=\(savedWID.map { String($0) } ?? "nil")")

        if let targetWID = savedWID {
            for (i, w) in windows.enumerated() {
                var wid: CGWindowID = 0
                if _AXUIElementGetWindow(w, &wid) == .success {
                    debugLog("  win[\(i)] CGWindowID=\(wid)")
                    if wid == targetWID {
                        debugLog("MATCH strategy0: CGWindowID")
                        raiseWindow(w, app: app, axApp: axApp)
                        return
                    }
                }
            }
            debugLog("strategy0: no CGWindowID match found")
        }

        // 读取保存的标题（剥离 braille spinner 前缀）
        let savedTitle: String = {
            guard let s = try? String(contentsOfFile: windowFilePath, encoding: .utf8) else { return "" }
            return stripTitlePrefix(s.trimmingCharacters(in: .whitespacesAndNewlines))
        }()
        debugLog("savedTitle=[\(savedTitle)]")

        // 读取保存的位置
        let savedPos: (x: Double, y: Double)? = {
            guard let s = try? String(contentsOfFile: posFilePath, encoding: .utf8) else { return nil }
            let parts = s.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ",")
            guard parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]) else { return nil }
            return (x, y)
        }()
        debugLog("savedPos=\(savedPos.map { "\($0.x),\($0.y)" } ?? "nil")")

        // 收集所有窗口的标题和位置
        struct WinInfo { let el: AXUIElement; let title: String; let pos: CGPoint? }
        var infos: [WinInfo] = []
        for (i, w) in windows.enumerated() {
            var titleRef: CFTypeRef?
            let title: String
            if AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &titleRef) == .success,
               let t = titleRef as? String { title = stripTitlePrefix(t) } else { title = "" }
            var posRef: CFTypeRef?
            var pos: CGPoint? = nil
            if AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &posRef) == .success,
               let pr = posRef {
                var pt = CGPoint.zero
                if AXValueGetValue(unsafeBitCast(pr, to: AXValue.self), .cgPoint, &pt) { pos = pt }
            }
            infos.append(WinInfo(el: w, title: title, pos: pos))
            debugLog("  win[\(i)] title=[\(title)] pos=\(pos.map { "\($0.x),\($0.y)" } ?? "nil")")
        }

        // 策略 0.5：项目名匹配 —— 多 IDE 窗口场景的核心策略
        // 每个 IDE 窗口标题以项目名称开头（如 "MyProject – file.kt"），
        // 用 Project: 行精确定位正确的窗口，当且仅当唯一匹配时才使用。
        let projectName: String = {
            guard let line = storedMetaLines.first(where: { $0.hasPrefix("Project:") }),
                  let idx = line.firstIndex(of: ":") else { return "" }
            return line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
        }()
        debugLog("projectName=[\(projectName)]")
        if !projectName.isEmpty {
            let projMatches = infos.filter { info in
                let t = info.title
                if t == projectName { return true }
                guard t.hasPrefix(projectName) else { return false }
                // Require the character after the project name to be non-alphanumeric
                // (space, dash, em-dash, bracket …) so "MyProject" won't match "MyProjectFoo"
                let afterIdx = t.index(t.startIndex, offsetBy: projectName.count)
                let nextChar = t[afterIdx]
                return !nextChar.isLetter && !nextChar.isNumber && nextChar != "_"
            }
            debugLog("strategy0.5: project-name matches=\(projMatches.count)")
            if projMatches.count == 1 {
                debugLog("MATCH strategy0.5: project-name unique")
                raiseWindow(projMatches[0].el, app: app, axApp: axApp)
                return
            }
        }

        // 策略 1：标题 + 位置 组合匹配
        if !savedTitle.isEmpty, let sp = savedPos {
            if let m = infos.first(where: {
                $0.title == savedTitle && $0.pos != nil &&
                abs($0.pos!.x - sp.x) < 5 && abs($0.pos!.y - sp.y) < 5
            }) {
                debugLog("MATCH strategy1: title+pos")
                raiseWindow(m.el, app: app, axApp: axApp)
                return
            }
        }

        // 策略 2：仅标题匹配
        if !savedTitle.isEmpty {
            let matches = infos.filter { $0.title == savedTitle }
            debugLog("strategy2: title matches=\(matches.count)")
            if let m = matches.first {
                debugLog("MATCH strategy2: title-only")
                raiseWindow(m.el, app: app, axApp: axApp)
                return
            }
        }

        // 策略 3：仅位置匹配（唯一时）
        if let sp = savedPos {
            let matches = infos.filter {
                $0.pos != nil && abs($0.pos!.x - sp.x) < 5 && abs($0.pos!.y - sp.y) < 5
            }
            debugLog("strategy3: pos matches=\(matches.count)")
            if matches.count == 1 {
                debugLog("MATCH strategy3: pos-only unique")
                raiseWindow(matches[0].el, app: app, axApp: axApp)
                return
            }
        }

        debugLog("NO MATCH — fallback activate")
        app.activate(options: [])
    }

    /// Create (or re-create) the kqueue DispatchSource that watches the content file.
    /// kqueue monitors a file descriptor (inode), not a path — if the file is replaced
    /// (atomic write = tmp + rename), the old fd becomes stale and no events fire.
    /// This method cancels any existing source and opens a fresh fd on the current inode.
    func setupFileWatcher() {
        fileWatchSource?.cancel()
        fileWatchSource = nil

        let fd = open(contentFilePath, O_EVTONLY)
        guard fd >= 0 else { return }

        // Record the inode so we can detect replacements later
        var stat_buf = stat()
        if fstat(fd, &stat_buf) == 0 {
            watchedInode = stat_buf.st_ino
        }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .delete, .rename], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            let flags = source.data
            if flags.contains(.delete) || flags.contains(.rename) {
                // File was replaced (new inode) — re-establish watcher on the new file
                self.setupFileWatcher()
            }
            self.reloadContent()
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        fileWatchSource = source
    }

    /// Periodic fallback: if the content file's inode changed (e.g. atomic write
    /// replaced the file while DispatchSource missed the event), re-establish the
    /// watcher and reload.  Runs every 5 seconds — lightweight stat() call only.
    @objc func checkInodeChanged() {
        var stat_buf = stat()
        guard stat(contentFilePath, &stat_buf) == 0 else { return }
        if stat_buf.st_ino != watchedInode {
            setupFileWatcher()
            reloadContent()
        }
    }

    func reloadContent() {
        guard let text = try? String(contentsOfFile: contentFilePath, encoding: .utf8) else { return }

        // __APPROVAL__ content: enter approval mode, or stay in it.
        // Must return early — NEVER parse __APPROVAL__ as normal content.
        if text.hasPrefix("__APPROVAL__") {
            if !isApproval {
                if let approvalRaw = try? String(contentsOfFile: approvalFilePath, encoding: .utf8),
                   let approvalObj = try? JSONSerialization.jsonObject(with: Data(approvalRaw.utf8)) as? [String: Any] {
                    approvalData = approvalObj
                    enterApprovalMode()
                } else {
                    // Approval JSON not ready yet — retry after a short delay
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                        self?.reloadContent()
                    }
                }
            }
            return
        }

        // No longer __APPROVAL__ but was in approval mode → exit and restore
        if isApproval {
            exitApprovalMode(restoreSaved: true)
            return
        }

        // Normal content — must have __STATE__ marker
        guard text.contains("__STATE__:") else { return }
        updateLabels(from: text)
        applyTheme()

        // ── Auto-collapse/expand by state ────────────────────────────────────
        // When the task is actively working, the sticky note collapses into a
        // compact circle so it doesn't distract.  Non-working states (completed,
        // approval) expand the note back so the result is visible at a glance.
        let isActive = (currentState == "working")
        if isActive && !isCollapsed {
            collapseWindowAction()
        } else if !isActive && isCollapsed {
            expandWindow()
        }

        if isCollapsed, let icon = iconLabel {
            // Update circle icon but do NOT auto-expand
            icon.stringValue = extractIcon(from: headerLabel.stringValue)
            icon.sizeToFit()
            let cs: CGFloat = 44
            let lw = max(icon.frame.width, 28), lh = max(icon.frame.height, 28)
            icon.frame = NSRect(x: (cs - lw) / 2, y: (cs - lh) / 2, width: lw, height: lh)
        }
        // Reset idle close timer on every content update
        scheduleCloseTimer()
        animatePulse()
    }

    // Schedule (or reschedule) the auto-close timer.
    // Each call invalidates the previous timer and starts a fresh one,
    // so the window only closes after `closeTimeout` seconds of inactivity.
    func scheduleCloseTimer() {
        closeTimer?.invalidate()
        closeTimer = Timer.scheduledTimer(withTimeInterval: closeTimeout, repeats: false) { _ in
            NSApp.terminate(nil)
        }
    }

    // Color-wash + scale-bounce: background blooms amber while card bounces.
    // In urgent mode: red flash + stronger scale bounce.
    func animatePulse() {
        guard let layer = window?.contentView?.layer else { return }

        let easeIn  = CAMediaTimingFunction(name: .easeIn)
        let easeOut = CAMediaTimingFunction(name: .easeOut)

        if isCollapsed {
            // Circle: shrink-first pulse + border ring brightens
            let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
            pulse.values      = [1.0, 0.82, 1.0, 0.92, 1.0]
            pulse.keyTimes    = [0,   0.25, 0.5, 0.75, 1.0]
            pulse.duration    = isUrgent ? 0.30 : 0.40
            pulse.repeatCount = isUrgent ? 3 : 2
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(pulse, forKey: "updatePulse")

            let curW = layer.borderWidth
            let bw = CAKeyframeAnimation(keyPath: "borderWidth")
            bw.values          = [curW, curW + (isUrgent ? 4.0 : 2.5), curW]
            bw.keyTimes        = [0,    0.15,                            1.0]
            bw.duration        = 1.0
            bw.timingFunctions = [easeIn, easeOut]
            bw.isRemovedOnCompletion = true
            layer.add(bw, forKey: "updateGlow")
            return
        }

        if isUrgent {
            // ── Urgent expanded: aggressive scale bounce + red flash ────────

            // 1. More aggressive scale bounce
            let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
            pulse.values      = [1.0, 1.35, 0.88, 1.18, 0.94, 1.0]
            pulse.keyTimes    = [0,   0.20, 0.45, 0.65, 0.82, 1.0]
            pulse.duration    = 0.50
            pulse.repeatCount = 3
            pulse.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(pulse, forKey: "updatePulse")

            // 2. Background color: red → deep crimson → red (3 rapid flashes)
            let appleCG  = NSColor(calibratedRed: 0.92, green: 0.16, blue: 0.14, alpha: 1.0).cgColor
            let flashCG  = NSColor(calibratedRed: 0.65, green: 0.04, blue: 0.04, alpha: 1.0).cgColor

            let wash = CAKeyframeAnimation(keyPath: "backgroundColor")
            wash.values          = [appleCG, flashCG, appleCG, flashCG, appleCG, flashCG, appleCG]
            wash.keyTimes        = [0,       0.10,    0.22,    0.34,    0.46,    0.58,    1.0]
            wash.duration        = 1.4
            wash.timingFunctions = [easeIn, easeOut, easeIn, easeOut, easeIn, easeOut]
            wash.isRemovedOnCompletion = true
            layer.add(wash, forKey: "updateWash")

            // 3. White border glow
            layer.borderColor = NSColor.white.withAlphaComponent(0.6).cgColor
            let totalDuration = pulse.duration * Double(pulse.repeatCount)
            let bw = CAKeyframeAnimation(keyPath: "borderWidth")
            bw.values          = [0,   2.5, 0]
            bw.keyTimes        = [0,   0.05, 0.9]
            bw.duration        = totalDuration
            bw.timingFunctions = [easeIn, easeOut]
            bw.isRemovedOnCompletion = true
            layer.add(bw, forKey: "updateBorder")

        } else {
            // ── Normal expanded: scale bounce + color wash + border glow ───

            // 1. Scale bounce
            let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
            pulse.values      = [1.0, 1.25, 0.90, 1.10, 0.96, 1.0]
            pulse.keyTimes    = [0,   0.25, 0.5,  0.7,  0.85, 1.0]
            pulse.duration    = 0.55
            pulse.repeatCount = 3
            pulse.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(pulse, forKey: "updatePulse")

            // 2. Background color wash: cream → amber → cream
            let amberCG = NSColor(calibratedRed: 0.96, green: 0.72, blue: 0.10, alpha: 1.0).cgColor
            let creamCG = NSColor(calibratedRed: 0.98, green: 0.96, blue: 0.72, alpha: 1.0).cgColor
            let flashCG = NSColor(calibratedRed: 0.99, green: 0.88, blue: 0.38, alpha: 1.0).cgColor

            let wash = CAKeyframeAnimation(keyPath: "backgroundColor")
            wash.values          = [creamCG, flashCG, creamCG]
            wash.keyTimes        = [0,       0.09,    1.0]
            wash.duration        = 1.1
            wash.timingFunctions = [easeIn, easeOut]
            wash.isRemovedOnCompletion = true
            layer.add(wash, forKey: "updateWash")

            // 3. Thin amber border glow
            layer.borderColor = amberCG
            let totalDuration = pulse.duration * Double(pulse.repeatCount)

            let bw = CAKeyframeAnimation(keyPath: "borderWidth")
            bw.values          = [0,   1.8,  0]
            bw.keyTimes        = [0,   0.05, 0.9]
            bw.duration        = totalDuration
            bw.timingFunctions = [easeIn, easeOut]
            bw.isRemovedOnCompletion = true
            layer.add(bw, forKey: "updateBorder")
        }
    }

    func updateLabels(from text: String) {
        var lines = text.components(separatedBy: "\n").filter { !$0.isEmpty }

        // Detect and strip the __URGENT__ sentinel written by notify.sh --urgent
        if lines.first == "__URGENT__" {
            isUrgent = true
            lines.removeFirst()
        } else {
            isUrgent = false
        }

        // Parse state from __STATE__:<state> line
        var parsedState: String = ""
        var projectName: String = ""
        storedMetaLines = []

        for line in lines {
            if line.hasPrefix("__STATE__:") {
                let value = line.replacingOccurrences(of: "__STATE__:", with: "").trimmingCharacters(in: .whitespaces)
                if !value.isEmpty { parsedState = value }
            } else if line.hasPrefix("Project:") {
                projectName = line.replacingOccurrences(of: "Project:", with: "").trimmingCharacters(in: .whitespaces)
                storedMetaLines.append(line)
            } else {
                storedMetaLines.append(line)
            }
        }

        currentState = parsedState.isEmpty ? "working" : parsedState
        // Track last non-approval state: when the urgent Notification hook fires
        // before the approval hook, currentState is "approval" but the real
        // pre-approval state was whatever came before (usually "working").
        if currentState != "approval" {
            lastNormalState = currentState
        }

        // Build header: icon + project name
        let icon = iconForState(currentState)
        headerLabel.stringValue = projectName.isEmpty ? icon : "\(icon) \(projectName)"

        // Set single-line content
        contentLabel.stringValue = statusTextForState(currentState)

        // Remove stale meta line labels (no longer rendered)
        for lbl in metaLineLabels { lbl.removeFromSuperview() }
        metaLineLabels.removeAll()

        updateTooltips()
    }

    /// Called after noteW changes (user drags resize handle).
    /// Anchors the window's RIGHT edge and moves the left edge.
    func relayout() {
        let w = noteW
        let rowY: CGFloat = noteH - 28

        // Move left edge; right edge stays at current screen position
        var f = window.frame
        f.origin.x = f.maxX - w
        f.size.width = w
        window.setFrame(f, display: true, animate: false)

        // Reposition subviews (cardView itself auto-fills the window as contentView)
        headerLabel.frame  = NSRect(x: 16, y: rowY, width: w - 64, height: 20)
        collapseBtn.frame  = NSRect(x: w - 48, y: rowY + 1, width: 18, height: 18)
        closeBtn.frame     = NSRect(x: w - 26, y: rowY,     width: 20, height: 20)
        dividerView.frame  = NSRect(x: 16, y: rowY - 4,     width: w - 24, height: 1)
        resizeHandle.frame = NSRect(x: w - 4, y: 0,         width: 4, height: rowY - 4)
        contentLabel.frame = NSRect(x: 16, y: 42,           width: w - 24, height: 24)

        cardView.closeBtnFrame = closeBtn.frame
        cardView.contentFrame  = NSRect(x: 16, y: 8, width: w - 24, height: noteH - 16)

        updateTooltips()
    }

    /// Rebuilds cardView.tooltipZones for any content that is truncated with "…".
    /// Uses activeAlways NSTrackingArea + custom panel — works even when the window
    /// is shown via orderFrontRegardless and the app never becomes the active app.
    /// No-op when window is collapsed (circle mode).
    func updateTooltips() {
        cardView.hideTooltip()
        if isCollapsed {
            // 折叠时：在整个圆圈区域显示项目名称作为 tooltip
            // storedMetaLines 存的是原始行，格式 "Project: value"（冒号+空格）
            let projectName = storedMetaLines
                .first(where: { $0.hasPrefix("Project:") })
                .flatMap { line -> String? in
                    guard let idx = line.firstIndex(of: ":") else { return nil }
                    let value = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
                    return value.isEmpty ? nil : value
                }
            if let name = projectName {
                cardView.tooltipZones = [(rect: cardView.bounds, text: name)]
            } else {
                cardView.tooltipZones = []
            }
            return
        }

        var zones: [(rect: NSRect, text: String)] = []

        // ── Header ──────────────────────────────────────────────────────────
        let headerText = headerLabel.stringValue
        if !headerText.isEmpty, let font = headerLabel.font {
            let naturalW = (headerText as NSString)
                .size(withAttributes: [.font: font]).width
            if naturalW > headerLabel.frame.width {
                zones.append((headerLabel.frame, headerText))
            }
        }

        // ── Content label ────────────────────────────────────────────────────
        let contentText = contentLabel.stringValue
        if !contentText.isEmpty, let font = contentLabel.font {
            let naturalW = (contentText as NSString)
                .size(withAttributes: [.font: font]).width
            if naturalW > contentLabel.frame.width {
                zones.append((contentLabel.frame, contentText))
            }
        }

        cardView.tooltipZones = zones
    }

    /// Apply the current theme (normal / urgent) to all visible UI elements.
    /// Safe to call multiple times; idempotent.
    func applyTheme() {
        // Card background
        cardView.layer?.backgroundColor = cardBgColor.cgColor

        // Header text
        headerLabel.textColor = headerTextColor

        // Accent bar colors
        accentBar.followColor = accentFollowColor
        accentBar.pinnedColor = accentPinnedColor
        // Re-trigger the color refresh in AccentBarView
        accentBar.isFollowing = accentBar.isFollowing

        // Collapse / close button tint
        collapseBtn.attributedTitle = NSAttributedString(string: "▾", attributes: [
            .foregroundColor: closeBtnColor,
            .font: NSFont.systemFont(ofSize: 11, weight: .medium)
        ])
        closeBtn.attributedTitle = NSAttributedString(string: "✕", attributes: [
            .foregroundColor: closeBtnColor,
            .font: NSFont.systemFont(ofSize: 12, weight: .medium)
        ])

        // Divider line
        dividerView.layer?.backgroundColor = dividerColor.cgColor

        // Content label
        contentLabel.textColor = headerTextColor

        // If currently collapsed, update the circle border color too
        if isCollapsed {
            cardView.layer?.borderColor = accentBar.currentColor.cgColor
        }
    }

    func enterApprovalMode() {
        guard approvalData != nil else { return }

        // Save pre-approval state for restoration
        preApprovalState = lastNormalState
        preApprovalHeaderText = headerLabel.stringValue
        preApprovalIsUrgent = isUrgent
        preApprovalContentText = contentLabel.stringValue

        // Update header to show the approval icon while keeping the project name
        let projectName = storedMetaLines
            .first(where: { $0.hasPrefix("Project:") })
            .flatMap { line -> String? in
                guard let idx = line.firstIndex(of: ":") else { return nil }
                return line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
            }
        headerLabel.stringValue = "🔐 " + (projectName ?? "")

        // If collapsed, expand so the user can see and interact with the buttons
        if isCollapsed { expandWindow() }

        isApproval = true
        approvalButtonsDisabled = false
        closeTimer?.invalidate()
        closeTimer = nil

        // Use urgent-red background (same as --urgent); temporarily set isUrgent
        // so cardBgColor / headerTextColor / … resolve to the red theme.
        isUrgent = true
        cardView.layer?.backgroundColor = cardBgColor.cgColor
        headerLabel.textColor = headerTextColor
        collapseBtn.attributedTitle = NSAttributedString(string: "▾", attributes: [
            .foregroundColor: closeBtnColor,
            .font: NSFont.systemFont(ofSize: 11, weight: .medium)
        ])
        closeBtn.attributedTitle = NSAttributedString(string: "✕", attributes: [
            .foregroundColor: closeBtnColor,
            .font: NSFont.systemFont(ofSize: 12, weight: .medium)
        ])
        dividerView.layer?.backgroundColor = dividerColor.cgColor
        accentBar.followColor = accentFollowColor
        accentBar.pinnedColor = accentPinnedColor
        accentBar.isFollowing = accentBar.isFollowing

        // Hide content label; buttons replace it
        contentLabel.isHidden = true

        // Clean up any stale meta line labels
        for lbl in metaLineLabels { lbl.removeFromSuperview() }
        metaLineLabels.removeAll()

        // ── Horizontal button row: Allow / Deny / Always ─────────────────
        let buttonFont = NSFont.systemFont(ofSize: 11, weight: .medium)
        let btnGap: CGFloat = 6
        let btnPadH: CGFloat = 12   // horizontal padding per button

        // Deny uses off-white bg + dark-red text to stand out on the red card
        let denyBg = NSColor(calibratedRed: 0.95, green: 0.93, blue: 0.93, alpha: 1.0)
        let denyText = NSColor(calibratedRed: 0.55, green: 0.08, blue: 0.08, alpha: 1.0)

        let buttonDefs: [(title: String, action: Selector, bgColor: NSColor, textColor: NSColor)] = [
            ("Allow",  #selector(approvalAllowAction),
             NSColor(calibratedRed: 0.18, green: 0.62, blue: 0.18, alpha: 1.0),
             NSColor.white),
            ("Deny",   #selector(approvalDenyAction),
             denyBg, denyText),
            ("Always", #selector(approvalAlwaysAction),
             NSColor(calibratedRed: 0.95, green: 0.62, blue: 0.10, alpha: 1.0),
             NSColor.white),
        ]

        // Compute each button width from its label text
        let btnWidths: [CGFloat] = buttonDefs.map { def in
            let textW = (def.title as NSString).size(withAttributes: [.font: buttonFont]).width
            return ceil(textW) + btnPadH
        }
        let totalBtnWidth = btnWidths.reduce(0, +) + CGFloat(buttonDefs.count - 1) * btnGap
        let contentWidth = noteW - 24
        let btnStartX: CGFloat = 16 + (contentWidth - totalBtnWidth) / 2
        let btnH: CGFloat = 24
        let btnY: CGFloat = 12

        var xCursor = btnStartX
        for (i, def) in buttonDefs.enumerated() {
            let bw = btnWidths[i]
            let container = NSView(frame: NSRect(x: xCursor, y: btnY, width: bw, height: btnH))
            container.wantsLayer = true
            container.layer?.backgroundColor = def.bgColor.cgColor
            container.layer?.cornerRadius = 5

            let textSize = (def.title as NSString).size(withAttributes: [.font: buttonFont])
            let lbl = NSTextField(labelWithString: def.title)
            lbl.font = buttonFont
            lbl.textColor = def.textColor
            lbl.alignment = .center
            lbl.drawsBackground = false
            lbl.isBordered = false
            lbl.frame = NSRect(x: 0, y: (btnH - textSize.height) / 2,
                               width: bw, height: textSize.height)
            container.addSubview(lbl)

            let click = NSClickGestureRecognizer(target: self, action: def.action)
            container.addGestureRecognizer(click)
            cardView.addSubview(container)
            approvalButtons.append(container)

            xCursor += bw + btnGap
        }

        cardView.closeBtnFrame = closeBtn.frame
        cardView.contentFrame = NSRect(x: 16, y: 8, width: noteW - 24, height: noteH - 16)
    }

    func exitApprovalMode(statusText: String? = nil, restoreSaved: Bool = false) {
        isApproval = false
        approvalData = nil
        for btn in approvalButtons { btn.removeFromSuperview() }
        approvalButtons.removeAll()
        for lbl in metaLineLabels { lbl.removeFromSuperview() }
        metaLineLabels.removeAll()

        if restoreSaved {
            // Restore pre-approval state — buttons gone, back to normal
            currentState = preApprovalState
            isUrgent = preApprovalIsUrgent
            headerLabel.stringValue = preApprovalHeaderText
            contentLabel.isHidden = false
            contentLabel.stringValue = preApprovalContentText
            applyTheme()

            // If the pre-approval state was "working", collapse back to circle
            if preApprovalState == "working" && !isCollapsed {
                collapseWindowAction()
            }
        } else if let text = statusText {
            // Legacy path: parse text as new content
            updateLabels(from: text)
            applyTheme()
        }

        cardView.closeBtnFrame = closeBtn.frame
        cardView.contentFrame = NSRect(x: 16, y: 8, width: noteW - 24, height: noteH - 16)
        scheduleCloseTimer()
    }

    /// Dismiss urgent mode: reset to normal theme (visual only).
    /// Safe to call when not in urgent mode (no-op).
    /// Does NOT write to the content file — atomic writes (tmp+rename) change the
    /// file's inode, which silently kills the kqueue-based DispatchSource watcher.
    /// The __URGENT__ sentinel in the file is harmless: the next notify.sh write
    /// overwrites the entire file content, and reloadContent() re-evaluates isUrgent
    /// from the new content each time.
    func dismissUrgent() {
        guard isUrgent else { return }
        isUrgent = false
        applyTheme()
    }

    func applicationWillTerminate(_ notification: Notification) {
        cardView?.hideTooltip()
        inodeCheckTimer?.invalidate()
        fileWatchSource?.cancel()
        try? FileManager.default.removeItem(atPath: pidFilePath)
        try? FileManager.default.removeItem(atPath: focusFilePath)
        try? FileManager.default.removeItem(atPath: windowFilePath)
        try? FileManager.default.removeItem(atPath: posFilePath)
        try? FileManager.default.removeItem(atPath: widFilePath)
        try? FileManager.default.removeItem(atPath: slotFilePath)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let contentFilePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
// Write PID file BEFORE entering the run loop so that any concurrent process
// (notify.sh / approval-server.js) can immediately detect this running instance
// and skip launching a duplicate window.  Eliminates the race where both sides
// checked the pid file before applicationDidFinishLaunching wrote it.
let pidFilePath = contentFilePath.hasSuffix(".txt")
    ? String(contentFilePath.dropLast(4)) + ".pid"
    : contentFilePath + ".pid"
try? String(ProcessInfo.processInfo.processIdentifier).write(toFile: pidFilePath, atomically: true, encoding: .utf8)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // Hide from Dock
let delegate = AppDelegate(contentFilePath: contentFilePath)
app.delegate = delegate
app.run()
