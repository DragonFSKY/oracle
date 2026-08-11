import AppKit
import CryptoKit
import Foundation
import UserNotifications

private enum OperatorLanguageSettings {
    static let key = "operatorLanguage"

    static var current: String {
        let value = UserDefaults.standard.string(forKey: key)
        return value == "zh-CN" || value == "en" ? value! : "system"
    }
}

private struct RelayAttachment: Codable, Hashable {
    let id: String
    let filename: String
    let displayPath: String
    let mimeType: String?
    let sizeBytes: Int
    let sha256: String
    let direction: String
}

private struct RelayTaskResponse: Codable {
    let markdown: String
    let submittedBy: String?
    let submittedAt: String
    let attachments: [RelayAttachment]
}

private struct RelayLocalReceiver: Codable {
    let version: Int
    let baseUrl: String
    let token: String
    let expiresAt: String
}

private struct RelayTask: Codable, Identifiable {
    let id: String
    let requestId: String?
    let status: String
    let title: String
    let prompt: String
    let modelHint: String?
    let createdAt: String
    let updatedAt: String
    let claimedBy: String?
    let localReceiver: RelayLocalReceiver?
    let attachments: [RelayAttachment]
    let response: RelayTaskResponse?
}

private struct OperatorBody: Encodable {
    let `operator`: String
}

private struct ResponseFileBody: Encodable {
    let filename: String
    let mimeType: String?
    let contentBase64: String
}

private struct ResponseBody: Encodable {
    let `operator`: String
    let markdown: String
    let attachments: [ResponseFileBody]
}

private struct ResponseUploadAttachmentBody: Encodable, Sendable {
    let filename: String
    let mimeType: String?
    let sizeBytes: Int
    let sha256: String
}

private struct ResponseUploadRequestBody: Encodable {
    let `operator`: String
    let markdown: String
    let attachments: [ResponseUploadAttachmentBody]
}

private struct ResponseUploadPlan: Decodable {
    let id: String
    let attachments: [RelayAttachment]
    let uploadChunkBytes: Int
    let alreadyComplete: Bool?
}

private struct LocalReceiverHealth: Decodable {
    let version: Int
    let requestId: String
    let taskId: String
}

private struct LocalResponseReceipt: Decodable {
    let version: Int
    let receiptId: String
    let taskId: String
}

private struct PreparedResponseFile: Sendable {
    let url: URL
    let metadata: ResponseUploadAttachmentBody
}

private enum ResponsePasteResult: Equatable {
    case noAttachments
    case attachments
}

private final class ResponseTextView: NSTextView {
    var onPasteAttachments: ((NSPasteboard) -> ResponsePasteResult)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if isPasteShortcut(event) {
            paste(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if isPasteShortcut(event) {
            paste(nil)
            return
        }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        if onPasteAttachments?(NSPasteboard.general) == .attachments {
            return
        }
        pasteAsPlainText(sender)
    }

    private func isPasteShortcut(_ event: NSEvent) -> Bool {
        guard event.charactersIgnoringModifiers?.lowercased() == "v" else { return false }
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        return modifiers == .command || modifiers == .control
    }
}

private enum RelayError: LocalizedError {
    case invalidURL
    case invalidResponse
    case http(Int, String)
    case checksum(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return OperatorLocale.t("error.url-invalid", OperatorLanguageSettings.current)
        case .invalidResponse:
            return OperatorLocale.t("error.invalid-response", OperatorLanguageSettings.current)
        case let .http(status, message):
            return OperatorLocale.t("error.request", OperatorLanguageSettings.current, ["status": String(status), "detail": message])
        case let .checksum(filename):
            return OperatorLocale.t("attachment.checksum-invalid", OperatorLanguageSettings.current, ["filename": filename])
        }
    }
}

private final class RelayAPI {
    let baseURL: String
    let token: String
    private let session: URLSession

    init(baseURL: String, token: String) {
        self.baseURL = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        self.session = URLSession(configuration: configuration)
    }

    func get<T: Decodable>(_ path: String, timeoutInterval: TimeInterval = 60) async throws -> T {
        var request = try makeRequest(path: path, method: "GET", timeoutInterval: timeoutInterval)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return try await perform(request)
    }

    func post<T: Decodable, Body: Encodable>(
        _ path: String,
        body: Body,
        timeoutInterval: TimeInterval = 60
    ) async throws -> T {
        var request = try makeRequest(path: path, method: "POST", timeoutInterval: timeoutInterval)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request)
    }

    func download(_ path: String) async throws -> URL {
        let request = try makeRequest(path: path, method: "GET")
        let (temporary, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse else { throw RelayError.invalidResponse }
        guard (200 ..< 300).contains(http.statusCode) else {
            let errorData = (try? Data(contentsOf: temporary)) ?? Data()
            throw RelayError.http(
                http.statusCode,
                String(data: errorData, encoding: .utf8) ?? OperatorLocale.t("error.unknown", OperatorLanguageSettings.current)
            )
        }
        return temporary
    }

    func uploadResponseAttachment(
        taskID: String,
        uploadID: String,
        attachment: RelayAttachment,
        fileURL: URL,
        chunkBytes: Int
    ) async throws {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        let chunkSize = max(1, chunkBytes)
        var start = 0
        while start < attachment.sizeBytes {
            let count = min(chunkSize, attachment.sizeBytes - start)
            try handle.seek(toOffset: UInt64(start))
            let data = try handle.read(upToCount: count) ?? Data()
            guard data.count == count else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let end = start + count - 1
            var lastError: Error?
            for attempt in 1 ... 3 {
                do {
                    var request = try makeRequest(
                        path: "/v1/tasks/\(taskID)/responses/\(uploadID)/attachments/\(attachment.id)",
                        method: "PUT",
                        timeoutInterval: 5 * 60
                    )
                    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                    request.setValue(String(data.count), forHTTPHeaderField: "Content-Length")
                    request.setValue(
                        "bytes \(start)-\(end)/\(attachment.sizeBytes)",
                        forHTTPHeaderField: "Content-Range"
                    )
                    let (responseData, response) = try await session.upload(for: request, from: data)
                    try validate(response: response, data: responseData)
                    lastError = nil
                    break
                } catch {
                    lastError = error
                    if !isRetryableUploadError(error) || attempt == 3 { throw error }
                    try await Task.sleep(nanoseconds: UInt64(attempt) * 500_000_000)
                }
            }
            if let lastError { throw lastError }
            start += count
        }
    }

    private func makeRequest(path: String, method: String, timeoutInterval: TimeInterval = 60) throws -> URLRequest {
        guard let url = URL(string: baseURL + path) else { throw RelayError.invalidURL }
        var request = URLRequest(url: url, timeoutInterval: timeoutInterval)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw RelayError.invalidResponse }
        guard (200 ..< 300).contains(http.statusCode) else {
            throw RelayError.http(http.statusCode, String(data: data, encoding: .utf8) ?? OperatorLocale.t("error.unknown", OperatorLanguageSettings.current))
        }
    }

    private func isRetryableUploadError(_ error: Error) -> Bool {
        guard case let RelayError.http(status, _) = error else { return true }
        return status == 408 || status == 429 || status >= 500
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private static let fixedRelayURL = configurationValue(
        environment: "ORACLE_RELAY_OPERATOR_URL",
        bundleKey: "OracleRelayURL"
    )
    private static let fixedOperatorToken = configurationValue(
        environment: "ORACLE_RELAY_OPERATOR_TOKEN",
        bundleKey: "OracleRelayOperatorToken"
    )
    private static let expandedWindowAutosaveName = "OracleRelayExpandedWindow"
    private static let compactWindowAutosaveName = "OracleRelayCompactWindow"
    private static let expandedDefaultContentSize = NSSize(width: 760, height: 820)
    private static let compactDefaultContentSize = NSSize(width: 620, height: 92)

    private let defaults = UserDefaults.standard
    private let fileManager = FileManager.default
    private var statusItem: NSStatusItem!
    private var panel: NSPanel!
    private var compactPanel: NSPanel!
    private var pollTimer: Timer?
    private var isPolling = false
    private var hasConnected = false
    private var isSubmittingResponse = false
    private var isUserHidden = false
    private var tasks: [RelayTask] = []
    private var activeTask: RelayTask?
    private var downloadedFiles: [String: URL] = [:]
    private var responseFiles: [URL] = []
    private var seenTaskIDs: Set<String> = []
    private var lastHeartbeatAt: Date?
    private var isCompact = false
    private var expandedZoomRestoreFrame: NSRect?
    private var compactZoomRestoreFrame: NSRect?

    private var languageSetting: String {
        get { OperatorLanguageSettings.current }
        set { defaults.set(newValue == "zh-CN" || newValue == "en" ? newValue : "system", forKey: OperatorLanguageSettings.key) }
    }

    private func t(_ key: String, _ values: [String: String] = [:]) -> String {
        OperatorLocale.t(key, languageSetting, values)
    }

    private func statusLabel(_ raw: String) -> String {
        ["uploading", "queued", "claimed", "awaiting-response", "completed", "cancelled", "expired"].contains(raw) ? t("status.\(raw)") : raw
    }

    private let taskPopup = NSPopUpButton()
    private let compactTaskPopup = NSPopUpButton()
    private let expandButton = NSButton(title: "", target: nil, action: nil)
    private let compactMinimizeButton = NSButton(title: "", target: nil, action: nil)
    private let compactCopyPromptButton = NSButton(title: "", target: nil, action: nil)
    private let compactCopyAttachmentsButton = NSButton(title: "", target: nil, action: nil)
    private let compactPasteSubmitButton = NSButton(title: "", target: nil, action: nil)
    private let connectionLabel = NSTextField(labelWithString: "")
    private let taskTitleLabel = NSTextField(labelWithString: "")
    private let taskStatusLabel = NSTextField(labelWithString: "")
    private let promptView = NSTextView()
    private let attachmentStack = NSStackView()
    private let answerView = ResponseTextView()
    private let responseFilesLabel = NSTextField(labelWithString: "")
    private let copyPromptButton = NSButton(title: "", target: nil, action: nil)
    private let submittedButton = NSButton(title: "", target: nil, action: nil)
    private let abortButton = NSButton(title: "", target: nil, action: nil)
    private let submitButton = NSButton(title: "", target: nil, action: nil)

    private var relayURL: String {
        Self.fixedRelayURL
    }

    private var operatorToken: String {
        Self.fixedOperatorToken
    }

    private var operatorName: String {
        if let saved = defaults.string(forKey: "operatorName"), !saved.isEmpty { return saved }
        let host = Host.current().localizedName?.replacingOccurrences(of: " ", with: "-") ?? "mac"
        return "mac-\(host)"
    }

    private var api: RelayAPI {
        RelayAPI(baseURL: relayURL, token: operatorToken)
    }

    private static func configurationValue(environment: String, bundleKey: String) -> String {
        let processValue = ProcessInfo.processInfo.environment[environment]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let processValue, !processValue.isEmpty { return processValue }
        return (Bundle.main.object(forInfoDictionaryKey: bundleKey) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        registerDefaults()
        applyLocalizedChrome()
        configureStatusItem()
        configurePanel()
        requestNotificationPermission()
        seenTaskIDs = Set(defaults.stringArray(forKey: "seenTaskIDs") ?? [])
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        poll()
    }

    private func applyLocalizedChrome() {
        expandButton.title = t("expand"); compactMinimizeButton.title = t("window.minimize")
        compactCopyPromptButton.title = t("copy.prompt"); compactCopyAttachmentsButton.title = t("copy")
        compactPasteSubmitButton.title = t("answer.submit"); copyPromptButton.title = t("copy.prompt")
        submittedButton.title = t("mark.submitted"); abortButton.title = t("abort"); submitButton.title = t("answer.submit")
        connectionLabel.stringValue = t("connecting", ["url": relayURL]); taskTitleLabel.stringValue = t("task.none")
        updateResponseFileLabel()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return true
    }

    private func registerDefaults() {
        defaults.register(defaults: [
            "operatorName": operatorName,
            OperatorLanguageSettings.key: "system",
        ])
    }

    private func configureStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🧿"
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(NSMenuItem(title: t("window.show") + " Oracle Relay", action: #selector(showPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: t("refresh"), action: #selector(refreshNow), keyEquivalent: "r"))
        menu.addItem(NSMenuItem(title: t("window.minimize"), action: #selector(minimizePanel), keyEquivalent: "m"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: t("window.zoom"), action: #selector(toggleWindowZoom), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: t("window.reset"), action: #selector(resetWindowSize), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: t("settings") + "…", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: t("quit"), action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        statusItem.menu = menu
    }

    private func configurePanel() {
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.expandedDefaultContentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = t("app.title")
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.contentMinSize = NSSize(width: 500, height: 500)
        panel.delegate = self
        configureWindowControls(panel)
        restoreWindowFrame(
            panel,
            autosaveName: Self.expandedWindowAutosaveName,
            defaultContentSize: Self.expandedDefaultContentSize
        )

        compactPanel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.compactDefaultContentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        compactPanel.title = "🧿 Oracle Relay"
        compactPanel.level = .floating
        compactPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        compactPanel.isReleasedWhenClosed = false
        compactPanel.hidesOnDeactivate = false
        compactPanel.isMovableByWindowBackground = true
        compactPanel.contentMinSize = NSSize(width: 520, height: 76)
        compactPanel.delegate = self
        configureWindowControls(compactPanel)
        restoreWindowFrame(
            compactPanel,
            autosaveName: Self.compactWindowAutosaveName,
            defaultContentSize: Self.compactDefaultContentSize
        )

        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 10
        root.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        root.translatesAutoresizingMaskIntoConstraints = false

        let compactRoot = NSStackView()
        compactRoot.orientation = .vertical
        compactRoot.spacing = 6
        compactRoot.translatesAutoresizingMaskIntoConstraints = false
        let compactSummaryRow = NSStackView()
        compactSummaryRow.orientation = .horizontal
        compactSummaryRow.spacing = 8
        compactTaskPopup.target = self
        compactTaskPopup.action = #selector(compactTaskSelectionChanged)
        compactTaskPopup.setContentHuggingPriority(.defaultLow, for: .horizontal)
        compactTaskPopup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        expandButton.target = self
        expandButton.action = #selector(expandPanel)
        compactMinimizeButton.target = self
        compactMinimizeButton.action = #selector(minimizePanel)
        compactSummaryRow.addArrangedSubview(compactTaskPopup)
        compactSummaryRow.addArrangedSubview(compactMinimizeButton)
        compactSummaryRow.addArrangedSubview(expandButton)

        let compactActionRow = NSStackView()
        compactActionRow.orientation = .horizontal
        compactActionRow.spacing = 8
        compactCopyPromptButton.target = self
        compactCopyPromptButton.action = #selector(copyPrompt)
        compactCopyAttachmentsButton.target = self
        compactCopyAttachmentsButton.action = #selector(copyAllAttachments)
        compactPasteSubmitButton.target = self
        compactPasteSubmitButton.action = #selector(pasteAnswerAndSubmit)
        compactActionRow.addArrangedSubview(compactCopyPromptButton)
        compactActionRow.addArrangedSubview(compactCopyAttachmentsButton)
        compactActionRow.addArrangedSubview(compactPasteSubmitButton)
        compactActionRow.addArrangedSubview(NSButton(title: t("refresh"), target: self, action: #selector(refreshNow)))
        compactActionRow.setHuggingPriority(.required, for: .horizontal)
        compactRoot.addArrangedSubview(compactSummaryRow)
        compactRoot.addArrangedSubview(compactActionRow)
        if let compactContent = compactPanel.contentView {
            compactContent.addSubview(compactRoot)
            NSLayoutConstraint.activate([
                compactRoot.leadingAnchor.constraint(equalTo: compactContent.leadingAnchor, constant: 12),
                compactRoot.trailingAnchor.constraint(equalTo: compactContent.trailingAnchor, constant: -12),
                compactRoot.centerYAnchor.constraint(equalTo: compactContent.centerYAnchor),
                compactSummaryRow.widthAnchor.constraint(equalTo: compactRoot.widthAnchor),
            ])
        }

        let top = NSStackView()
        top.orientation = .horizontal
        top.spacing = 8
        taskPopup.target = self
        taskPopup.action = #selector(taskSelectionChanged)
        let refreshButton = NSButton(title: t("refresh"), target: self, action: #selector(refreshNow))
        let settingsButton = NSButton(title: t("settings"), target: self, action: #selector(showSettings))
        let collapseButton = NSButton(title: t("compact"), target: self, action: #selector(collapsePanel))
        let minimizeButton = NSButton(title: t("window.minimize"), target: self, action: #selector(minimizePanel))
        top.addArrangedSubview(taskPopup)
        top.addArrangedSubview(refreshButton)
        top.addArrangedSubview(settingsButton)
        top.addArrangedSubview(collapseButton)
        top.addArrangedSubview(minimizeButton)
        taskPopup.setContentHuggingPriority(.defaultLow, for: .horizontal)

        taskTitleLabel.font = .systemFont(ofSize: 18, weight: .semibold)
        taskStatusLabel.textColor = .secondaryLabelColor
        connectionLabel.textColor = .secondaryLabelColor
        [taskTitleLabel, taskStatusLabel, connectionLabel, responseFilesLabel].forEach {
            $0.lineBreakMode = .byTruncatingTail
            $0.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }

        configureTextView(promptView, editable: false)
        configureTextView(answerView, editable: true)
        answerView.onPasteAttachments = { [weak self] pasteboard in
            self?.pasteResponseAttachments(from: pasteboard) ?? .noAttachments
        }
        let promptScroll = makeScrollView(documentView: promptView)
        let answerScroll = makeScrollView(documentView: answerView)

        let promptButtons = NSStackView()
        promptButtons.orientation = .horizontal
        promptButtons.spacing = 8
        copyPromptButton.target = self
        copyPromptButton.action = #selector(copyPrompt)
        submittedButton.target = self
        submittedButton.action = #selector(markSubmitted)
        abortButton.target = self
        abortButton.action = #selector(abortTask)
        abortButton.bezelColor = .systemRed
        promptButtons.addArrangedSubview(copyPromptButton)
        promptButtons.addArrangedSubview(submittedButton)
        promptButtons.addArrangedSubview(abortButton)

        attachmentStack.orientation = .vertical
        attachmentStack.alignment = .leading
        attachmentStack.spacing = 6
        let attachmentContainer = NSView()
        attachmentContainer.translatesAutoresizingMaskIntoConstraints = false
        attachmentStack.translatesAutoresizingMaskIntoConstraints = false
        attachmentContainer.addSubview(attachmentStack)
        NSLayoutConstraint.activate([
            attachmentStack.leadingAnchor.constraint(equalTo: attachmentContainer.leadingAnchor),
            attachmentStack.trailingAnchor.constraint(equalTo: attachmentContainer.trailingAnchor),
            attachmentStack.topAnchor.constraint(equalTo: attachmentContainer.topAnchor),
            attachmentStack.bottomAnchor.constraint(lessThanOrEqualTo: attachmentContainer.bottomAnchor),
        ])
        let attachmentScroll = makeScrollView(documentView: attachmentContainer)

        let responseButtons = NSStackView()
        responseButtons.orientation = .horizontal
        responseButtons.spacing = 8
        responseButtons.addArrangedSubview(NSButton(
            title: t("attachments.response"),
            target: self,
            action: #selector(pasteResponseClipboard)
        ))
        responseButtons.addArrangedSubview(NSButton(title: t("response.files.add"), target: self, action: #selector(addResponseFiles)))
        responseButtons.addArrangedSubview(NSButton(title: t("response.files.clear"), target: self, action: #selector(clearResponseFiles)))
        submitButton.target = self
        submitButton.action = #selector(submitResponse)
        responseButtons.addArrangedSubview(submitButton)

        let promptSectionLabel = sectionLabel(t("prompt"))
        let attachmentSectionLabel = sectionLabel(t("attachments.request"))
        let answerSectionLabel = sectionLabel(t("answer"))

        root.addArrangedSubview(top)
        root.addArrangedSubview(connectionLabel)
        root.addArrangedSubview(taskTitleLabel)
        root.addArrangedSubview(taskStatusLabel)
        root.addArrangedSubview(promptSectionLabel)
        root.addArrangedSubview(promptButtons)
        root.addArrangedSubview(promptScroll)
        root.addArrangedSubview(attachmentSectionLabel)
        root.addArrangedSubview(attachmentScroll)
        root.addArrangedSubview(answerSectionLabel)
        root.addArrangedSubview(answerScroll)
        root.addArrangedSubview(responseFilesLabel)
        root.addArrangedSubview(responseButtons)

        guard let content = panel.contentView else { return }
        content.addSubview(root)
        let promptMinimumHeight = promptScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 80)
        let attachmentMinimumHeight = attachmentScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 60)
        let attachmentPreferredHeight = attachmentScroll.heightAnchor.constraint(equalToConstant: 150)
        let answerMinimumHeight = answerScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 80)
        promptMinimumHeight.priority = .defaultHigh
        attachmentMinimumHeight.priority = .defaultHigh
        attachmentPreferredHeight.priority = .defaultLow
        answerMinimumHeight.priority = .defaultHigh
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            root.topAnchor.constraint(equalTo: content.topAnchor),
            root.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            top.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32),
            connectionLabel.widthAnchor.constraint(equalTo: top.widthAnchor),
            taskTitleLabel.widthAnchor.constraint(equalTo: top.widthAnchor),
            taskStatusLabel.widthAnchor.constraint(equalTo: top.widthAnchor),
            promptScroll.widthAnchor.constraint(equalTo: top.widthAnchor),
            promptMinimumHeight,
            attachmentScroll.widthAnchor.constraint(equalTo: top.widthAnchor),
            attachmentMinimumHeight,
            attachmentPreferredHeight,
            answerScroll.widthAnchor.constraint(equalTo: top.widthAnchor),
            answerMinimumHeight,
            responseFilesLabel.widthAnchor.constraint(equalTo: top.widthAnchor),
        ])
        updateUI()
        setCompactMode(true, animated: false)
    }

    private func configureTextView(_ textView: NSTextView, editable: Bool) {
        textView.isEditable = editable
        textView.isSelectable = true
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.isRichText = false
        textView.autoresizingMask = [.width]
    }

    private func makeScrollView(documentView: NSView) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.borderType = .bezelBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = documentView
        scroll.translatesAutoresizingMaskIntoConstraints = false
        return scroll
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 14, weight: .semibold)
        return label
    }

    private func configureWindowControls(_ window: NSWindow) {
        window.isMovable = true
        if let minimizeButton = window.standardWindowButton(.miniaturizeButton) {
            minimizeButton.isHidden = false
            minimizeButton.isEnabled = true
            minimizeButton.target = self
            minimizeButton.action = #selector(minimizePanel)
        }
        if let zoomButton = window.standardWindowButton(.zoomButton) {
            zoomButton.isHidden = false
            zoomButton.isEnabled = true
            zoomButton.target = self
            zoomButton.action = #selector(toggleWindowZoom)
        }
    }

    private func restoreWindowFrame(
        _ window: NSWindow,
        autosaveName: String,
        defaultContentSize: NSSize
    ) {
        let restored = window.setFrameUsingName(autosaveName)
        window.setFrameAutosaveName(autosaveName)
        if !restored {
            window.setContentSize(defaultContentSize)
            window.center()
        }
    }

    private var activeWindow: NSWindow? {
        isCompact ? compactPanel : panel
    }

    private func constrainToVisibleScreen(_ window: NSWindow) {
        guard let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame else { return }
        var frame = window.frame
        if frame.width > visible.width { frame.size.width = visible.width }
        if frame.height > visible.height { frame.size.height = visible.height }
        if frame.maxX > visible.maxX { frame.origin.x = visible.maxX - frame.width }
        if frame.minX < visible.minX { frame.origin.x = visible.minX }
        if frame.maxY > visible.maxY { frame.origin.y = visible.maxY - frame.height }
        if frame.minY < visible.minY { frame.origin.y = visible.minY }
        window.setFrame(frame, display: true)
    }

    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        standardZoomFrame(for: window) ?? newFrame
    }

    private func standardZoomFrame(for window: NSWindow) -> NSRect? {
        guard let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame else {
            return nil
        }
        let horizontalInset = min(24, visible.width * 0.05)
        let verticalInset = min(24, visible.height * 0.05)
        return visible.insetBy(dx: horizontalInset, dy: verticalInset)
    }

    @objc private func showPanel() {
        isUserHidden = false
        NSApp.activate(ignoringOtherApps: true)
        if isCompact {
            compactPanel.makeKeyAndOrderFront(nil)
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    @objc private func expandPanel() { setCompactMode(false, animated: true) }
    @objc private func collapsePanel() { setCompactMode(true, animated: true) }
    @objc private func minimizePanel() {
        isUserHidden = true
        panel.orderOut(nil)
        compactPanel.orderOut(nil)
    }

    @objc private func toggleWindowZoom() {
        showPanel()
        guard let window = activeWindow else { return }
        let restoreFrame = isCompact ? compactZoomRestoreFrame : expandedZoomRestoreFrame
        if let restoreFrame {
            if isCompact {
                compactZoomRestoreFrame = nil
            } else {
                expandedZoomRestoreFrame = nil
            }
            window.setFrame(restoreFrame, display: true, animate: true)
            constrainToVisibleScreen(window)
            return
        }
        guard let zoomFrame = standardZoomFrame(for: window) else { return }
        if isCompact {
            compactZoomRestoreFrame = window.frame
        } else {
            expandedZoomRestoreFrame = window.frame
        }
        window.setFrame(zoomFrame, display: true, animate: true)
    }

    @objc private func resetWindowSize() {
        guard let window = activeWindow else { return }
        if isCompact {
            compactZoomRestoreFrame = nil
        } else {
            expandedZoomRestoreFrame = nil
        }
        let defaultSize = isCompact
            ? Self.compactDefaultContentSize
            : Self.expandedDefaultContentSize
        let topLeft = NSPoint(x: window.frame.minX, y: window.frame.maxY)
        window.setContentSize(defaultSize)
        var frame = window.frame
        frame.origin = NSPoint(x: topLeft.x, y: topLeft.y - frame.height)
        window.setFrame(frame, display: true, animate: true)
        constrainToVisibleScreen(window)
    }

    private func setCompactMode(_ compact: Bool, animated: Bool) {
        guard let expandedPanel = panel, let collapsedPanel = compactPanel else { return }
        guard compact != isCompact else {
            updateCompactSummary()
            return
        }
        let source = compact ? expandedPanel : collapsedPanel
        let target = compact ? collapsedPanel : expandedPanel
        let sourceFrame = source.frame
        var targetFrame = target.frame
        isCompact = compact
        targetFrame.origin = NSPoint(
            x: sourceFrame.minX,
            y: sourceFrame.maxY - targetFrame.height
        )
        if let visible = source.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            if targetFrame.maxX > visible.maxX { targetFrame.origin.x = visible.maxX - targetFrame.width }
            if targetFrame.minX < visible.minX { targetFrame.origin.x = visible.minX }
            if targetFrame.maxY > visible.maxY { targetFrame.origin.y = visible.maxY - targetFrame.height }
            if targetFrame.minY < visible.minY { targetFrame.origin.y = visible.minY }
        }
        source.orderOut(nil)
        target.setFrame(targetFrame, display: true, animate: animated)
        constrainToVisibleScreen(target)
        if !isUserHidden {
            target.orderFront(nil)
        }
        updateCompactSummary()
    }

    @objc private func refreshNow() { poll() }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func taskSelectionChanged() {
        guard taskPopup.indexOfSelectedItem >= 0, taskPopup.indexOfSelectedItem < tasks.count else { return }
        requestTaskSwitch(to: tasks[taskPopup.indexOfSelectedItem].id)
    }

    @objc private func compactTaskSelectionChanged() {
        guard compactTaskPopup.indexOfSelectedItem >= 0,
              compactTaskPopup.indexOfSelectedItem < tasks.count else { return }
        requestTaskSwitch(to: tasks[compactTaskPopup.indexOfSelectedItem].id)
    }

    private func requestTaskSwitch(to taskID: String) {
        guard taskID != activeTask?.id else { return }
        guard !isSubmittingResponse else {
            restoreActiveTaskSelections()
            showTransientMessage(t("operator.busy-submit"))
            return
        }
        let hasDraft = !answerView.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !responseFiles.isEmpty
        guard !hasDraft else {
            restoreActiveTaskSelections()
            showTransientMessage(t("operator.draft-active"))
            return
        }
        openTask(id: taskID)
    }

    private func restoreActiveTaskSelections() {
        guard let activeID = activeTask?.id,
              let index = tasks.firstIndex(where: { $0.id == activeID }) else { return }
        taskPopup.selectItem(at: index)
        compactTaskPopup.selectItem(at: index)
    }

    private func poll() {
        guard !isPolling else { return }
        guard !relayURL.isEmpty, !operatorToken.isEmpty else {
            connectionLabel.stringValue = t("error.missing-config")
            return
        }
        isPolling = true
        if !hasConnected && !isSubmittingResponse {
            connectionLabel.stringValue = t("connecting", ["url": relayURL])
        }
        Task {
            defer { isPolling = false }
            do {
                let latest: [RelayTask] = try await api.get("/v1/tasks")
                applyTaskList(latest)
                await sendHeartbeatIfNeeded()
            } catch {
                if !isSubmittingResponse {
                    connectionLabel.stringValue = t("connection.failed", ["message": error.localizedDescription])
                }
            }
        }
    }

    private func applyTaskList(_ latest: [RelayTask]) {
        let previousActiveID = activeTask?.id
        let previousActiveStatus = activeTask?.status
        tasks = latest
        hasConnected = true
        statusItem.button?.title = latest.isEmpty ? "🧿" : "🧿 \(latest.count)"
        if !isSubmittingResponse {
            connectionLabel.stringValue = t("connected", ["count": String(latest.count), "operator": operatorName])
        }
        taskPopup.removeAllItems()
        compactTaskPopup.removeAllItems()
        let taskTitles = latest.map { "[\(statusLabel($0.status))] \($0.title)" }
        taskPopup.addItems(withTitles: taskTitles)
        compactTaskPopup.addItems(withTitles: taskTitles)
        if latest.isEmpty {
            compactTaskPopup.addItem(withTitle: t("task.none"))
            compactTaskPopup.isEnabled = false
        } else {
            compactTaskPopup.isEnabled = true
        }
        cleanupCaches(keeping: Set(latest.map(\.id)))

        let newTasks = latest.filter { !seenTaskIDs.contains($0.id) }
        for task in newTasks {
            seenTaskIDs.insert(task.id)
            notify(task: task)
        }
        defaults.set(Array(seenTaskIDs.suffix(500)), forKey: "seenTaskIDs")
        if !newTasks.isEmpty {
            setCompactMode(false, animated: true)
            if !isUserHidden {
                showPanel()
            }
        }

        if let previousActiveID, let index = latest.firstIndex(where: { $0.id == previousActiveID }) {
            taskPopup.selectItem(at: index)
            compactTaskPopup.selectItem(at: index)
            activeTask = latest[index]
            updateUI()
            if latest[index].status == "awaiting-response", previousActiveStatus != "awaiting-response" {
                setCompactMode(true, animated: true)
            }
        } else if let first = latest.first {
            taskPopup.selectItem(at: 0)
            compactTaskPopup.selectItem(at: 0)
            openTask(id: first.id)
        } else {
            activeTask = nil
            lastHeartbeatAt = nil
            downloadedFiles.removeAll()
            updateUI()
            setCompactMode(true, animated: true)
        }
    }

    private func openTask(id: String) {
        Task {
            do {
                var task: RelayTask = try await api.get("/v1/tasks/\(id)")
                if task.status == "queued" {
                    task = try await api.post("/v1/tasks/\(id)/claim", body: OperatorBody(operator: operatorName))
                }
                activeTask = task
                lastHeartbeatAt = nil
                downloadedFiles.removeAll()
                restorePastedResponseFiles(for: task.id)
                updateUI()
                try await downloadAttachments(for: task)
                setCompactMode(task.status == "awaiting-response", animated: true)
            } catch {
                if !discardInactiveTask(taskID: id, after: error) {
                    showError(error)
                }
                poll()
            }
        }
    }

    private func downloadAttachments(for task: RelayTask) async throws {
        let directory = cacheDirectory(for: task.id)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let expectedFiles = Set(task.attachments.enumerated().map { index, attachment in
            cachedFilename(for: attachment, index: index)
        })
        if let existing = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            for file in existing where file.lastPathComponent != "response-paste"
                && !expectedFiles.contains(file.lastPathComponent)
            {
                try? fileManager.removeItem(at: file)
            }
        }
        for (index, attachment) in task.attachments.enumerated() {
            let destination = directory.appendingPathComponent(cachedFilename(for: attachment, index: index))
            if fileManager.fileExists(atPath: destination.path),
               let attributes = try? fileManager.attributesOfItem(atPath: destination.path),
               (attributes[.size] as? NSNumber)?.intValue == attachment.sizeBytes
            {
                downloadedFiles[attachment.id] = destination
                renderAttachments()
                continue
            }
            let temporary = try await api.download("/v1/tasks/\(task.id)/attachments/\(attachment.id)")
            let digest = try sha256File(temporary)
            guard digest == attachment.sha256.lowercased() else {
                try? fileManager.removeItem(at: temporary)
                throw RelayError.checksum(cachedFilename(for: attachment, index: index))
            }
            try fileManager.moveItem(at: temporary, to: destination)
            downloadedFiles[attachment.id] = destination
            renderAttachments()
        }
    }

    private func sendHeartbeatIfNeeded() async {
        guard let task = activeTask,
              ["queued", "claimed", "awaiting-response"].contains(task.status) else {
            lastHeartbeatAt = nil
            return
        }
        if let lastHeartbeatAt, Date().timeIntervalSince(lastHeartbeatAt) < 45 { return }
        do {
            let updated: RelayTask = try await api.post(
                "/v1/tasks/\(task.id)/heartbeat",
                body: OperatorBody(operator: operatorName)
            )
            activeTask = updated
            lastHeartbeatAt = Date()
            updateUI()
        } catch {
            connectionLabel.stringValue = t("lease.failed", ["message": error.localizedDescription])
        }
    }

    private func updateUI() {
        guard let task = activeTask else {
            taskTitleLabel.stringValue = t("task.none")
            taskStatusLabel.stringValue = t("task.waiting")
            promptView.string = ""
            answerView.string = ""
            responseFiles.removeAll()
            updateResponseFileLabel()
            renderAttachments()
            setActionButtons(enabled: false)
            updateCompactSummary()
            return
        }
        taskTitleLabel.stringValue = task.title
        let transferMode = task.localReceiver == nil ? t("transfer.public") : t("transfer.local")
        taskStatusLabel.stringValue = "\(t("task.status", ["status": statusLabel(task.status)])) · \(t("task.model", ["model": task.modelHint ?? "—"])) · \(transferMode) · \(t("transfer.multi-device"))"
        promptView.string = task.prompt
        setActionButtons(enabled: ["queued", "claimed", "awaiting-response"].contains(task.status))
        renderAttachments()
        updateCompactSummary()
    }

    private func updateCompactSummary() {
        restoreActiveTaskSelections()
    }

    private func setActionButtons(enabled: Bool) {
        copyPromptButton.isEnabled = activeTask != nil
        compactCopyPromptButton.isEnabled = activeTask != nil
        submittedButton.isEnabled = enabled
        abortButton.isEnabled = enabled
        submitButton.isEnabled = enabled
        compactPasteSubmitButton.isEnabled = enabled && !isSubmittingResponse
        answerView.isEditable = enabled
        updateCompactAttachmentButton()
    }

    private func updateCompactAttachmentButton() {
        let attachments = activeTask?.attachments ?? []
        compactCopyAttachmentsButton.isHidden = attachments.isEmpty
        compactCopyAttachmentsButton.isEnabled = !attachments.isEmpty
            && attachments.allSatisfy { downloadedFiles[$0.id] != nil }
        compactCopyAttachmentsButton.title = attachments.count > 1
            ? t("attachments.copied", ["count": String(attachments.count)])
            : t("copy")
    }

    private func renderAttachments() {
        attachmentStack.arrangedSubviews.forEach {
            attachmentStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guard let task = activeTask, !task.attachments.isEmpty else {
            attachmentStack.addArrangedSubview(NSTextField(labelWithString: t("attachments.none")))
            updateCompactAttachmentButton()
            return
        }
        for (index, attachment) in task.attachments.enumerated() {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 6
            let ready = downloadedFiles[attachment.id] != nil
            let state = ready ? t("attachment.ready") : t("attachment.loading")
            let label = NSTextField(
                labelWithString: "\(t("attachments")) \(index + 1) · \(attachmentTypeLabel(attachment)) · \(formatBytes(attachment.sizeBytes)) · \(state)"
            )
            label.lineBreakMode = .byTruncatingTail
            label.setContentHuggingPriority(.defaultLow, for: .horizontal)
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            row.addArrangedSubview(label)
            let button = attachmentButton(ready ? t("copy") : t("attachment.loading"), action: #selector(copyAttachment), id: attachment.id)
            button.setContentHuggingPriority(.required, for: .horizontal)
            button.setContentCompressionResistancePriority(.required, for: .horizontal)
            row.addArrangedSubview(button)
            attachmentStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: attachmentStack.widthAnchor).isActive = true
        }
        updateCompactAttachmentButton()
    }

    private func attachmentButton(_ title: String, action: Selector, id: String) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.identifier = NSUserInterfaceItemIdentifier(id)
        button.isEnabled = downloadedFiles[id] != nil
        return button
    }

    @objc private func copyPrompt() {
        guard let task = activeTask else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(task.prompt, forType: .string)
        showTransientMessage(t("copy.success"))
    }

    @objc private func copyAttachment(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue,
              let url = downloadedFiles[id],
              let attachment = activeTask?.attachments.first(where: { $0.id == id }) else { return }
        copySingleAttachment(url: url, attachment: attachment)
    }

    private func copySingleAttachment(url: URL, attachment: RelayAttachment) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        if isImageAttachment(attachment), let image = NSImage(contentsOf: url) {
            pasteboard.writeObjects([image])
            showTransientMessage(t("attachment.copy-image"))
            return
        }
        if isTextAttachment(attachment) {
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                pasteboard.setString(text, forType: .string)
                showTransientMessage(t("attachment.copied"))
            } catch {
                showError(error)
            }
            return
        }
        pasteboard.writeObjects([url as NSURL])
        showTransientMessage(t("attachment.copy-file"))
    }

    @objc private func copyAllAttachments() {
        guard let task = activeTask, !task.attachments.isEmpty else { return }
        let files = task.attachments.compactMap { attachment -> (URL, RelayAttachment)? in
            guard let url = downloadedFiles[attachment.id] else { return nil }
            return (url, attachment)
        }
        guard files.count == task.attachments.count else {
            showTransientMessage(t("attachment.not-ready"))
            return
        }
        if files.count == 1, let first = files.first {
            copySingleAttachment(url: first.0, attachment: first.1)
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.writeObjects(files.map { $0.0 as NSURL })
        showTransientMessage(t("attachments.copied", ["count": String(files.count)]))
    }

    @objc private func pasteAnswerAndSubmit() {
        guard activeTask != nil else { return }
        guard responseFiles.isEmpty else {
            showTransientMessage(t("clipboard.response-files"))
            return
        }
        let pasteboard = NSPasteboard.general
        guard !pasteboardContainsFileOrImage(pasteboard) else {
            showTransientMessage(t("clipboard.expand"))
            return
        }
        guard let answer = pasteboard.string(forType: .string),
              !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            showTransientMessage(t("clipboard.no-text"))
            return
        }
        answerView.string = answer
        submitResponse()
    }

    private func pasteboardContainsFileOrImage(_ pasteboard: NSPasteboard) -> Bool {
        let files = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) ?? []
        if !files.isEmpty { return true }
        let imageTypes: Set<NSPasteboard.PasteboardType> = [
            .png,
            .tiff,
            NSPasteboard.PasteboardType("public.jpeg"),
            NSPasteboard.PasteboardType("public.heic"),
            NSPasteboard.PasteboardType("org.webmproject.webp"),
            NSPasteboard.PasteboardType("com.compuserve.gif"),
        ]
        return (pasteboard.pasteboardItems ?? []).contains { item in
            !imageTypes.isDisjoint(with: item.types)
        }
    }

    @objc private func markSubmitted() {
        guard let task = activeTask else { return }
        Task {
            do {
                let updated: RelayTask = try await api.post("/v1/tasks/\(task.id)/submitted", body: OperatorBody(operator: operatorName))
                activeTask = updated
                updateUI()
                setCompactMode(true, animated: true)
            } catch {
                if !discardInactiveTask(taskID: task.id, after: error) {
                    showError(error)
                }
            }
        }
    }

    @objc private func abortTask() {
        guard let task = activeTask else { return }
        let alert = NSAlert()
        alert.messageText = t("abort.title")
        alert.informativeText = t("abort.message")
        alert.addButton(withTitle: t("abort"))
        alert.addButton(withTitle: t("cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                let _: RelayTask = try await api.post("/v1/tasks/\(task.id)/abort", body: OperatorBody(operator: operatorName))
                removeCache(taskID: task.id)
                activeTask = nil
                lastHeartbeatAt = nil
                poll()
            } catch {
                if !discardInactiveTask(taskID: task.id, after: error) {
                    showError(error)
                }
            }
        }
    }

    @objc private func addResponseFiles() {
        let openPanel = NSOpenPanel()
        openPanel.allowsMultipleSelection = true
        openPanel.canChooseDirectories = false
        openPanel.canChooseFiles = true
        if openPanel.runModal() == .OK {
            responseFiles.append(contentsOf: openPanel.urls.filter { !responseFiles.contains($0) })
            updateResponseFileLabel()
        }
    }

    @objc private func pasteResponseClipboard() {
        guard pasteResponseAttachments(from: .general) == .noAttachments else { return }
        showTransientMessage(t("clipboard.no-files"))
    }

    private func pasteResponseAttachments(from pasteboard: NSPasteboard) -> ResponsePasteResult {
        let copiedFiles = (pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) ?? []).compactMap { object -> URL? in
            guard let url = object as? URL, url.isFileURL else { return nil }
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                return nil
            }
            return url.standardizedFileURL
        }
        if !copiedFiles.isEmpty {
            appendResponseFiles(copiedFiles)
            showTransientMessage(t("clipboard.files-added", ["count": String(copiedFiles.count)]))
            return .attachments
        }

        guard let task = activeTask else { return .noAttachments }
        do {
            let pastedImages = try materializePastedImages(from: pasteboard, taskID: task.id)
            guard !pastedImages.isEmpty else { return .noAttachments }
            appendResponseFiles(pastedImages)
            showTransientMessage(t("clipboard.images-added", ["count": String(pastedImages.count)]))
            return .attachments
        } catch {
            showError(error)
            return .attachments
        }
    }

    private func materializePastedImages(from pasteboard: NSPasteboard, taskID: String) throws -> [URL] {
        let jpeg = NSPasteboard.PasteboardType("public.jpeg")
        let heic = NSPasteboard.PasteboardType("public.heic")
        let webp = NSPasteboard.PasteboardType("org.webmproject.webp")
        let gif = NSPasteboard.PasteboardType("com.compuserve.gif")
        let representations: [(NSPasteboard.PasteboardType, String)] = [
            (.png, "png"),
            (jpeg, "jpg"),
            (heic, "heic"),
            (webp, "webp"),
            (gif, "gif"),
            (.tiff, "tiff"),
        ]
        var images: [(data: Data, extension: String)] = []
        for item in pasteboard.pasteboardItems ?? [] {
            guard let representation = representations.first(where: { item.data(forType: $0.0) != nil }),
                  let data = item.data(forType: representation.0) else { continue }
            if representation.0 == .tiff,
               let bitmap = NSBitmapImageRep(data: data),
               let png = bitmap.representation(using: .png, properties: [:])
            {
                images.append((png, "png"))
            } else {
                images.append((data, representation.1))
            }
        }
        if images.isEmpty {
            for image in pasteboard.readObjects(forClasses: [NSImage.self]) ?? [] {
                guard let image = image as? NSImage,
                      let tiff = image.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]) else { continue }
                images.append((png, "png"))
            }
        }
        guard !images.isEmpty else { return [] }

        let directory = pastedResponseDirectory(for: taskID)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
        var written: [URL] = []
        do {
            for (index, image) in images.enumerated() {
                let destination = uniquePastedImageURL(
                    in: directory,
                    basename: "pasted-image-\(timestamp)-\(index + 1)",
                    extension: image.extension
                )
                try image.data.write(to: destination, options: .atomic)
                written.append(destination)
            }
            return written
        } catch {
            written.forEach { try? fileManager.removeItem(at: $0) }
            throw error
        }
    }

    private func uniquePastedImageURL(in directory: URL, basename: String, extension ext: String) -> URL {
        var suffix = 0
        while true {
            let name = suffix == 0 ? basename : "\(basename)-\(suffix + 1)"
            let candidate = directory.appendingPathComponent(name).appendingPathExtension(ext)
            if !fileManager.fileExists(atPath: candidate.path) { return candidate }
            suffix += 1
        }
    }

    private func appendResponseFiles(_ urls: [URL]) {
        for url in urls where !responseFiles.contains(url) {
            responseFiles.append(url)
        }
        updateResponseFileLabel()
    }

    private func restorePastedResponseFiles(for taskID: String) {
        guard responseFiles.isEmpty else { return }
        let directory = pastedResponseDirectory(for: taskID)
        guard let cached = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        responseFiles = cached.filter { url in
            (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        updateResponseFileLabel()
    }

    @objc private func clearResponseFiles() {
        responseFiles.removeAll()
        if let taskID = activeTask?.id {
            try? fileManager.removeItem(at: pastedResponseDirectory(for: taskID))
        }
        updateResponseFileLabel()
    }

    private func updateResponseFileLabel() {
        responseFilesLabel.stringValue = responseFiles.isEmpty
            ? t("response.files.none-paste")
            : t("response.files.selected-paste", ["count": String(responseFiles.count)])
    }

    @objc private func submitResponse() {
        guard let task = activeTask else { return }
        let answer = answerView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answer.isEmpty || !responseFiles.isEmpty else {
            showTransientMessage(t("validation.response-required"))
            return
        }
        let selectedFiles = responseFiles
        let totalBytes = selectedFiles.reduce(Int64(0)) { total, url in
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            return total + size
        }
        isSubmittingResponse = true
        submitButton.isEnabled = false
        compactPasteSubmitButton.isEnabled = false
        connectionLabel.stringValue = totalBytes > 0
            ? t("response.uploading", ["bytes": ByteCountFormatter.string(fromByteCount: totalBytes, countStyle: .file)])
            : t("response.submitting")
        Task {
            do {
                let preparedFiles = try await Task.detached(priority: .userInitiated) {
                    try selectedFiles.map { url in
                        let values = try url.resourceValues(forKeys: [.fileSizeKey])
                        guard let sizeBytes = values.fileSize else {
                            throw CocoaError(.fileReadUnknown)
                        }
                        let handle = try FileHandle(forReadingFrom: url)
                        defer { try? handle.close() }
                        var hasher = SHA256()
                        while true {
                            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
                            if chunk.isEmpty { break }
                            hasher.update(data: chunk)
                        }
                        let sha256 = hasher.finalize().map { String(format: "%02x", $0) }.joined()
                        return PreparedResponseFile(
                            url: url,
                            metadata: ResponseUploadAttachmentBody(
                                filename: url.lastPathComponent,
                                mimeType: nil,
                                sizeBytes: sizeBytes,
                                sha256: sha256
                            )
                        )
                    }
                }.value
                if preparedFiles.isEmpty {
                    let body = ResponseBody(operator: operatorName, markdown: answer, attachments: [])
                    let _: RelayTask = try await api.post(
                        "/v1/tasks/\(task.id)/response",
                        body: body
                    )
                } else {
                    let request = ResponseUploadRequestBody(
                        operator: operatorName,
                        markdown: answer,
                        attachments: preparedFiles.map(\.metadata)
                    )
                    let deliveredLocally = await submitThroughLocalReceiverIfAvailable(
                        task: task,
                        request: request,
                        files: preparedFiles
                    )
                    if deliveredLocally {
                        connectionLabel.stringValue = t("transfer.local-sync")
                        let body = ResponseBody(operator: operatorName, markdown: answer, attachments: [])
                        let _: RelayTask = try await api.post(
                            "/v1/tasks/\(task.id)/response",
                            body: body
                        )
                    } else {
                        try await uploadStagedResponse(
                            api: api,
                            taskID: task.id,
                            request: request,
                            files: preparedFiles,
                            local: false
                        )
                    }
                }
                isSubmittingResponse = false
                removeCache(taskID: task.id)
                responseFiles.removeAll()
                answerView.string = ""
                activeTask = nil
                lastHeartbeatAt = nil
                updateResponseFileLabel()
                showTransientMessage(t("answer.submitted"))
                poll()
            } catch {
                isSubmittingResponse = false
                submitButton.isEnabled = true
                compactPasteSubmitButton.isEnabled = activeTask != nil
                if !discardInactiveTask(taskID: task.id, after: error) {
                    connectionLabel.stringValue = t("response.failed-retry")
                    showError(error)
                }
            }
        }
    }

    private func submitThroughLocalReceiverIfAvailable(
        task: RelayTask,
        request: ResponseUploadRequestBody,
        files: [PreparedResponseFile]
    ) async -> Bool {
        guard let receiver = task.localReceiver else {
            connectionLabel.stringValue = t("transfer.legacy")
            return false
        }
        guard receiver.version == 1,
              let baseURL = URL(string: receiver.baseUrl),
              baseURL.scheme == "http",
              baseURL.host == "127.0.0.1" || baseURL.host == "::1",
              baseURL.user == nil,
              baseURL.password == nil,
              receiver.token.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil,
              let expiresAt = ISO8601DateFormatter().date(from: receiver.expiresAt),
              expiresAt > Date()
        else { return false }

        let localAPI = RelayAPI(baseURL: receiver.baseUrl, token: receiver.token)
        do {
            connectionLabel.stringValue = t("transfer.probing")
            let health: LocalReceiverHealth = try await localAPI.get(
                "/v1/tasks/\(task.id)/health",
                timeoutInterval: 1.5
            )
            guard health.version == 1,
                  health.taskId == task.id,
                  task.requestId == nil || health.requestId == task.requestId
            else { return false }
            connectionLabel.stringValue = t("transfer.connected")
            try await uploadStagedResponse(
                api: localAPI,
                taskID: task.id,
                request: request,
                files: files,
                local: true
            )
            return true
        } catch {
            connectionLabel.stringValue = t("transfer.fallback")
            return false
        }
    }

    private func uploadStagedResponse(
        api targetAPI: RelayAPI,
        taskID: String,
        request: ResponseUploadRequestBody,
        files: [PreparedResponseFile],
        local: Bool
    ) async throws {
        let plan: ResponseUploadPlan = try await targetAPI.post(
            "/v1/tasks/\(taskID)/responses/uploads",
            body: request,
            timeoutInterval: local ? 5 : 60
        )
        guard plan.attachments.count == files.count else { throw RelayError.invalidResponse }
        if plan.alreadyComplete != true {
            for (index, pair) in zip(files, plan.attachments).enumerated() {
                connectionLabel.stringValue = local
                    ? t("transfer.upload-local", ["index": String(index + 1), "count": String(files.count), "bytes": formatBytes(pair.1.sizeBytes)])
                    : t("transfer.upload-public", ["index": String(index + 1), "count": String(files.count), "bytes": formatBytes(pair.1.sizeBytes)])
                try await targetAPI.uploadResponseAttachment(
                    taskID: taskID,
                    uploadID: plan.id,
                    attachment: pair.1,
                    fileURL: pair.0.url,
                    chunkBytes: plan.uploadChunkBytes
                )
            }
            connectionLabel.stringValue = local
                ? t("transfer.verify-local")
                : t("transfer.verify-public")
            if local {
                let _: LocalResponseReceipt = try await targetAPI.post(
                    "/v1/tasks/\(taskID)/responses/\(plan.id)/publish",
                    body: OperatorBody(operator: operatorName),
                    timeoutInterval: 10
                )
            } else {
                let _: RelayTask = try await targetAPI.post(
                    "/v1/tasks/\(taskID)/responses/\(plan.id)/publish",
                    body: OperatorBody(operator: operatorName)
                )
            }
        }
    }

    @objc private func showSettings() {
        let alert = NSAlert()
        alert.messageText = "Oracle Relay \(t("settings"))"
        alert.informativeText = t("settings.language.restart")
        alert.addButton(withTitle: t("settings.saved"))
        alert.addButton(withTitle: t("cancel"))

        let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 430, height: 38))
        stack.orientation = .vertical
        stack.spacing = 8
        let operatorField = NSTextField(string: operatorName)
        let languageField = NSPopUpButton()
        ["system", "zh-CN", "en"].forEach { languageField.addItem(withTitle: t("language.\($0)")) }
        languageField.selectItem(at: ["system", "zh-CN", "en"].firstIndex(of: languageSetting) ?? 0)
        for (label, field) in [(t("settings.operator-name"), operatorField)] {
            let row = NSStackView()
            row.orientation = .horizontal
            let title = NSTextField(labelWithString: label)
            title.frame.size.width = 110
            row.addArrangedSubview(title)
            row.addArrangedSubview(field)
            field.widthAnchor.constraint(equalToConstant: 300).isActive = true
            stack.addArrangedSubview(row)
        }
        let languageRow = NSStackView()
        languageRow.orientation = .horizontal
        languageRow.addArrangedSubview(NSTextField(labelWithString: t("language.label")))
        languageRow.addArrangedSubview(languageField)
        stack.addArrangedSubview(languageRow)
        alert.accessoryView = stack
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        defaults.set(operatorField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "operatorName")
        languageSetting = ["system", "zh-CN", "en"][languageField.indexOfSelectedItem]
        applyLocalizedChrome()
        poll()
    }

    private func cacheRoot() -> URL {
        fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("OracleRelay", isDirectory: true)
    }

    private func cacheDirectory(for taskID: String) -> URL {
        cacheRoot().appendingPathComponent(taskID, isDirectory: true)
    }

    private func pastedResponseDirectory(for taskID: String) -> URL {
        cacheDirectory(for: taskID).appendingPathComponent("response-paste", isDirectory: true)
    }

    private func removeCache(taskID: String) {
        try? fileManager.removeItem(at: cacheDirectory(for: taskID))
        downloadedFiles.removeAll()
    }

    private func cleanupCaches(keeping activeIDs: Set<String>) {
        let root = cacheRoot()
        guard let directories = try? fileManager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for directory in directories where !activeIDs.contains(directory.lastPathComponent) {
            try? fileManager.removeItem(at: directory)
        }
    }

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func notify(task: RelayTask) {
        let content = UNMutableNotificationContent()
        content.title = t("new.task")
        content.body = t("new.task.detail", ["title": task.title, "count": String(task.attachments.count)])
        content.sound = .default
        let request = UNNotificationRequest(identifier: task.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func showTransientMessage(_ text: String) {
        connectionLabel.stringValue = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.connectionLabel.stringValue = self.t("connected", ["count": String(self.tasks.count), "operator": self.operatorName])
        }
    }

    private func showError(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.runModal()
    }

    func windowWillClose(_ notification: Notification) {
        isUserHidden = true
    }

    @discardableResult
    private func discardInactiveTask(taskID: String, after error: Error) -> Bool {
        guard let relayError = error as? RelayError,
              case let .http(status, _) = relayError,
              status == 404 || status == 409 else { return false }
        removeCache(taskID: taskID)
        if activeTask?.id == taskID {
            activeTask = nil
            lastHeartbeatAt = nil
            downloadedFiles.removeAll()
            responseFiles.removeAll()
            answerView.string = ""
            updateResponseFileLabel()
            updateUI()
        }
        showTransientMessage(t("task.other-device-finished"))
        poll()
        return true
    }

    private func isTextAttachment(_ attachment: RelayAttachment) -> Bool {
        if attachment.mimeType?.lowercased().hasPrefix("text/") == true { return true }
        let extensions: Set<String> = [
            "txt", "md", "markdown", "json", "jsonl", "js", "jsx", "ts", "tsx", "css", "html",
            "xml", "yaml", "yml", "toml", "csv", "tsv", "log", "diff", "patch", "java", "kt",
            "kts", "groovy", "gradle", "properties", "sql", "sh", "bash", "zsh", "py", "rb", "go",
            "rs", "c", "h", "cc", "cpp", "hpp", "cs", "php", "vue", "svelte",
        ]
        return extensions.contains(URL(fileURLWithPath: attachment.filename).pathExtension.lowercased())
    }

    private func isImageAttachment(_ attachment: RelayAttachment) -> Bool {
        if attachment.mimeType?.lowercased().hasPrefix("image/") == true { return true }
        return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"].contains(
            URL(fileURLWithPath: attachment.filename).pathExtension.lowercased()
        )
    }

    private func cachedFilename(for attachment: RelayAttachment, index: Int) -> String {
        let ext = URL(fileURLWithPath: attachment.filename).pathExtension.lowercased()
            .filter { $0.isLetter || $0.isNumber }
        let base = "attachment-\(index + 1)"
        return ext.isEmpty ? base : "\(base).\(ext)"
    }

    private func sha256File(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func attachmentTypeLabel(_ attachment: RelayAttachment) -> String {
        if isImageAttachment(attachment) { return t("attachment.type.image") }
        if isTextAttachment(attachment) { return t("attachment.type.text") }
        let ext = URL(fileURLWithPath: attachment.filename).pathExtension.uppercased()
        return ext.isEmpty ? t("attachment.type.file") : ext
    }

    private func formatBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

@main
private struct OracleRelayOperatorApplication {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }
}
