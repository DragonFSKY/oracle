using System.Text.Json;

namespace OracleRelayOperator;

internal sealed class OperatorForm : Form
{
    private static readonly string AppDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OracleRelay");
    private static readonly string WindowStatePath = Path.Combine(AppDirectory, "window.json");

    private readonly RelayApi api = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly System.Windows.Forms.Timer pollTimer = new() { Interval = 5000 };
    private readonly NotifyIcon trayIcon = new();
    private readonly ComboBox taskPicker = new() { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly Label connectionLabel = new() { AutoEllipsis = true, Dock = DockStyle.Fill, Height = 24, Text = "正在连接…", TextAlign = ContentAlignment.MiddleLeft };
    private readonly Label taskLabel = new() { AutoEllipsis = true, Dock = DockStyle.Fill, Height = 26, Font = new Font(SystemFonts.DefaultFont, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
    private readonly TextBox promptBox = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill };
    private readonly FlowLayoutPanel attachmentPanel = new() { Dock = DockStyle.Fill, AutoScroll = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
    private readonly TextBox answerBox = new() { Multiline = true, ScrollBars = ScrollBars.Both, AcceptsReturn = true, Dock = DockStyle.Fill };
    private readonly Label responseFilesLabel = new() { AutoSize = true, Text = "未选择回传附件" };
    private readonly Button copyPromptButton = new() { Text = "复制提示词", AutoSize = true };
    private readonly Button submittedButton = new() { Text = "已粘贴，等待回答", AutoSize = true };
    private readonly Button abortButton = new() { Text = "中止任务", AutoSize = true };
    private readonly Button submitButton = new() { Text = "提交给开发机", AutoSize = true };
    private readonly Button compactButton = new() { Text = "收起悬浮窗", AutoSize = true };
    private readonly Panel contentPanel = new() { AutoScroll = true, Dock = DockStyle.Fill };
    private readonly HashSet<string> seenTaskIds = [];
    private readonly Dictionary<string, string> downloadedFiles = [];
    private readonly List<string> responseFiles = [];

    private List<RelayTask> tasks = [];
    private RelayTask? activeTask;
    private DateTimeOffset? lastHeartbeatAt;
    private Rectangle expandedBounds;
    private bool polling;
    private bool updatingPicker;
    private bool compact;
    private bool allowClose;

    internal OperatorForm()
    {
        Text = "🧿 Oracle Relay 操作端";
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        MinimumSize = new Size(460, 420);
        Size = new Size(840, 780);
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        TopMost = true;
        BuildUi();
        ConfigureTray();
        RestoreWindowState();
        SetActionsEnabled(false);

        pollTimer.Tick += async (_, _) => await PollAsync();
        Shown += async (_, _) =>
        {
            pollTimer.Start();
            await PollAsync();
        };
        FormClosing += OnFormClosing;
        Resize += (_, _) =>
        {
            if (WindowState == FormWindowState.Minimized) Hide();
        };
    }

    private void BuildUi()
    {
        var menu = new MenuStrip();
        var windowMenu = new ToolStripMenuItem("窗口");
        windowMenu.DropDownItems.Add("放大/还原", null, (_, _) => ToggleZoom());
        windowMenu.DropDownItems.Add("恢复默认大小", null, (_, _) => ResetWindowSize());
        windowMenu.DropDownItems.Add("置顶", null, (_, _) => TopMost = !TopMost);
        menu.Items.Add(windowMenu);
        MainMenuStrip = menu;

        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            ColumnCount = 3,
            RowCount = 1,
            Padding = new Padding(8),
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var refreshButton = new Button { Text = "刷新", AutoSize = true };
        refreshButton.Click += async (_, _) => await PollAsync();
        compactButton.Click += (_, _) => SetCompactMode(!compact);
        taskPicker.SelectedIndexChanged += async (_, _) =>
        {
            if (!updatingPicker && taskPicker.SelectedItem is TaskChoice choice)
                await OpenTaskAsync(choice.Task.Id);
        };
        header.Controls.Add(taskPicker, 0, 0);
        header.Controls.Add(refreshButton, 1, 0);
        header.Controls.Add(compactButton, 2, 0);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 10,
            Padding = new Padding(10),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 35));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 25));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        layout.Controls.Add(connectionLabel, 0, 0);
        layout.Controls.Add(taskLabel, 0, 1);
        layout.Controls.Add(new Label { Text = "提示词", AutoSize = true }, 0, 2);
        layout.Controls.Add(promptBox, 0, 3);

        promptBox.MinimumSize = new Size(0, 100);
        var promptActions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true };
        copyPromptButton.Click += (_, _) => CopyPrompt();
        submittedButton.Click += async (_, _) => await MarkSubmittedAsync();
        abortButton.Click += async (_, _) => await AbortAsync();
        promptActions.Controls.AddRange([copyPromptButton, submittedButton, abortButton]);
        layout.Controls.Add(promptActions, 0, 4);

        var attachmentsGroup = new GroupBox { Text = "请求附件", Dock = DockStyle.Fill };
        attachmentsGroup.MinimumSize = new Size(0, 90);
        attachmentsGroup.Controls.Add(attachmentPanel);
        layout.Controls.Add(attachmentsGroup, 0, 5);
        layout.Controls.Add(new Label { Text = "回传回答（Markdown）", AutoSize = true }, 0, 6);
        layout.Controls.Add(answerBox, 0, 7);

        answerBox.MinimumSize = new Size(0, 140);
        var responseActions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true };
        var addFilesButton = new Button { Text = "添加回传附件…", AutoSize = true };
        var clearFilesButton = new Button { Text = "清空附件", AutoSize = true };
        addFilesButton.Click += (_, _) => AddResponseFiles();
        clearFilesButton.Click += (_, _) => ClearResponseFiles();
        responseActions.Controls.AddRange([addFilesButton, clearFilesButton, responseFilesLabel]);
        layout.Controls.Add(responseActions, 0, 8);
        submitButton.Click += async (_, _) => await SubmitResponseAsync();
        layout.Controls.Add(submitButton, 0, 9);

        contentPanel.Controls.Add(layout);
        void FitLayoutToViewport() => layout.MinimumSize = new Size(0, contentPanel.ClientSize.Height);
        contentPanel.ClientSizeChanged += (_, _) => FitLayoutToViewport();
        FitLayoutToViewport();
        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        shell.Controls.Add(header, 0, 0);
        shell.Controls.Add(contentPanel, 0, 1);
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.Controls.Add(menu, 0, 0);
        root.Controls.Add(shell, 0, 1);
        Controls.Add(root);
    }

    private void ConfigureTray()
    {
        trayIcon.Icon = SystemIcons.Application;
        trayIcon.Text = "Oracle Relay";
        trayIcon.Visible = true;
        trayIcon.DoubleClick += (_, _) => ShowWindow();
        var menu = new ContextMenuStrip();
        menu.Items.Add("显示", null, (_, _) => ShowWindow());
        menu.Items.Add("放大/还原", null, (_, _) => ToggleZoom());
        menu.Items.Add("恢复默认大小", null, (_, _) => ResetWindowSize());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => Shutdown());
        trayIcon.ContextMenuStrip = menu;
    }

    private async Task PollAsync()
    {
        if (polling || lifetime.IsCancellationRequested) return;
        polling = true;
        try
        {
            connectionLabel.Text = $"正在连接 {RelayConfig.Url}…";
            var latest = await api.GetTasksAsync(lifetime.Token);
            await ApplyTaskListAsync(latest);
            await SendHeartbeatIfNeededAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception error)
        {
            connectionLabel.Text = $"连接失败：{error.Message}";
        }
        finally
        {
            polling = false;
        }
    }

    private async Task ApplyTaskListAsync(List<RelayTask> latest)
    {
        var previousId = activeTask?.Id;
        var previousStatus = activeTask?.Status;
        tasks = latest;
        trayIcon.Text = latest.Count == 0 ? "Oracle Relay" : $"Oracle Relay · {latest.Count} 个任务";
        connectionLabel.Text = $"已连接 · {latest.Count} 个待处理任务 · {RelayConfig.OperatorName}";

        updatingPicker = true;
        taskPicker.Items.Clear();
        foreach (var task in latest) taskPicker.Items.Add(new TaskChoice(task));
        updatingPicker = false;

        foreach (var task in latest.Where(task => seenTaskIds.Add(task.Id)))
        {
            trayIcon.BalloonTipTitle = "Oracle Relay 有新任务";
            trayIcon.BalloonTipText = $"{task.Title} · {task.Attachments.Count} 个附件";
            trayIcon.ShowBalloonTip(5000);
            SetCompactMode(false);
            ShowWindow();
        }
        CleanupCaches(latest.Select(task => task.Id).ToHashSet(StringComparer.Ordinal));

        if (previousId is not null && latest.FirstOrDefault(task => task.Id == previousId) is { } current)
        {
            activeTask = current;
            SelectTask(current.Id);
            UpdateUi();
            if (current.Status == "awaiting-response" && previousStatus != "awaiting-response")
                SetCompactMode(true);
        }
        else if (latest.Count > 0)
        {
            await OpenTaskAsync(latest[0].Id);
        }
        else
        {
            activeTask = null;
            downloadedFiles.Clear();
            lastHeartbeatAt = null;
            UpdateUi();
            SetCompactMode(true);
        }
    }

    private async Task OpenTaskAsync(string taskId)
    {
        try
        {
            var task = await api.GetTaskAsync(taskId, lifetime.Token);
            if (task.Status == "queued") task = await api.ClaimAsync(task.Id, lifetime.Token);
            activeTask = task;
            lastHeartbeatAt = null;
            downloadedFiles.Clear();
            SelectTask(task.Id);
            UpdateUi();
            await DownloadAttachmentsAsync(task);
            SetCompactMode(task.Status == "awaiting-response");
        }
        catch (Exception error)
        {
            if (!DiscardInactiveTask(taskId, error)) ShowError(error);
            await PollAsync();
        }
    }

    private async Task DownloadAttachmentsAsync(RelayTask task)
    {
        var directory = CacheDirectory(task.Id);
        Directory.CreateDirectory(directory);
        for (var index = 0; index < task.Attachments.Count; index++)
        {
            var attachment = task.Attachments[index];
            var extension = Path.GetExtension(SafeFilename(attachment.Filename));
            var destination = Path.Combine(directory, $"attachment-{index + 1}{extension}");
            var existing = new FileInfo(destination);
            if (!existing.Exists || existing.Length != attachment.SizeBytes)
                await api.DownloadAttachmentAsync(task.Id, attachment, destination, lifetime.Token);
            downloadedFiles[attachment.Id] = destination;
            RenderAttachments();
        }
    }

    private async Task SendHeartbeatIfNeededAsync()
    {
        if (activeTask is not { } task ||
            task.Status is not ("queued" or "claimed" or "awaiting-response"))
        {
            lastHeartbeatAt = null;
            return;
        }
        if (lastHeartbeatAt is { } last && DateTimeOffset.UtcNow - last < TimeSpan.FromSeconds(45)) return;
        activeTask = await api.HeartbeatAsync(task.Id, lifetime.Token);
        lastHeartbeatAt = DateTimeOffset.UtcNow;
        UpdateUi();
    }

    private void UpdateUi()
    {
        if (activeTask is null)
        {
            taskLabel.Text = "暂无任务";
            promptBox.Text = "";
            answerBox.Text = "";
            responseFiles.Clear();
            UpdateResponseFilesLabel();
            RenderAttachments();
            SetActionsEnabled(false);
            return;
        }
        taskLabel.Text = $"{activeTask.Title} · {activeTask.Status} · 建议模型：{activeTask.ModelHint ?? "自行选择"}";
        promptBox.Text = activeTask.Prompt;
        SetActionsEnabled(activeTask.Status is "queued" or "claimed" or "awaiting-response");
        RenderAttachments();
    }

    private void RenderAttachments()
    {
        attachmentPanel.Controls.Clear();
        if (activeTask is null || activeTask.Attachments.Count == 0)
        {
            attachmentPanel.Controls.Add(new Label { Text = "无附件", AutoSize = true });
            return;
        }
        for (var index = 0; index < activeTask.Attachments.Count; index++)
        {
            var attachment = activeTask.Attachments[index];
            var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
            row.Controls.Add(new Label
            {
                AutoSize = true,
                Text = $"附件 {index + 1} · {FormatBytes(attachment.SizeBytes)} · " +
                       (downloadedFiles.ContainsKey(attachment.Id) ? "可复制" : "获取中…"),
            });
            var copyButton = new Button { Text = "复制", AutoSize = true, Enabled = downloadedFiles.ContainsKey(attachment.Id), Tag = attachment };
            copyButton.Click += (_, _) => CopyAttachment((RelayAttachment)copyButton.Tag!);
            row.Controls.Add(copyButton);
            attachmentPanel.Controls.Add(row);
        }
    }

    private void SetActionsEnabled(bool enabled)
    {
        copyPromptButton.Enabled = activeTask is not null;
        submittedButton.Enabled = enabled;
        abortButton.Enabled = enabled;
        submitButton.Enabled = enabled;
        answerBox.ReadOnly = !enabled;
    }

    private void CopyPrompt()
    {
        if (activeTask is null) return;
        Clipboard.SetText(activeTask.Prompt);
        connectionLabel.Text = "提示词已复制";
    }

    private void CopyAttachment(RelayAttachment attachment)
    {
        if (!downloadedFiles.TryGetValue(attachment.Id, out var path)) return;
        try
        {
            if (IsTextAttachment(attachment))
            {
                Clipboard.SetText(File.ReadAllText(path));
            }
            else if (IsImageAttachment(attachment))
            {
                using var source = Image.FromFile(path);
                using var copy = new Bitmap(source);
                Clipboard.SetImage(copy);
            }
            else
            {
                var files = new System.Collections.Specialized.StringCollection { path };
                Clipboard.SetFileDropList(files);
            }
            connectionLabel.Text = "附件已复制";
        }
        catch (Exception error)
        {
            ShowError(error);
        }
    }

    private async Task MarkSubmittedAsync()
    {
        if (activeTask is null) return;
        var taskId = activeTask.Id;
        try
        {
            activeTask = await api.MarkSubmittedAsync(activeTask.Id, lifetime.Token);
            UpdateUi();
            SetCompactMode(true);
        }
        catch (Exception error)
        {
            if (!DiscardInactiveTask(taskId, error)) ShowError(error);
        }
    }

    private async Task AbortAsync()
    {
        if (activeTask is null) return;
        var taskId = activeTask.Id;
        if (MessageBox.Show(
                "开发机上的等待会立即结束。外部 AI 客户端中的生成需要另行停止。",
                "确定中止任务？",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning) != DialogResult.OK) return;
        try
        {
            await api.AbortAsync(activeTask.Id, lifetime.Token);
            RemoveCache(activeTask.Id);
            activeTask = null;
            lastHeartbeatAt = null;
            await PollAsync();
        }
        catch (Exception error)
        {
            if (!DiscardInactiveTask(taskId, error)) ShowError(error);
        }
    }

    private void AddResponseFiles()
    {
        using var dialog = new OpenFileDialog { Multiselect = true, Title = "选择回传附件" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        foreach (var file in dialog.FileNames.Where(File.Exists))
            if (!responseFiles.Contains(file, StringComparer.OrdinalIgnoreCase)) responseFiles.Add(file);
        UpdateResponseFilesLabel();
    }

    private void ClearResponseFiles()
    {
        responseFiles.Clear();
        UpdateResponseFilesLabel();
    }

    private void UpdateResponseFilesLabel() =>
        responseFilesLabel.Text = responseFiles.Count == 0 ? "未选择回传附件" : $"已选择 {responseFiles.Count} 个回传附件";

    private async Task SubmitResponseAsync()
    {
        if (activeTask is null) return;
        var taskId = activeTask.Id;
        var markdown = answerBox.Text.Trim();
        if (markdown.Length == 0 && responseFiles.Count == 0)
        {
            MessageBox.Show("请粘贴回答或选择回传附件。", "Oracle Relay", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        submitButton.Enabled = false;
        try
        {
            var files = new List<ResponseFileBody>();
            foreach (var path in responseFiles)
            {
                files.Add(new ResponseFileBody
                {
                    Filename = Path.GetFileName(path),
                    MimeType = MimeType(path),
                    ContentBase64 = Convert.ToBase64String(await File.ReadAllBytesAsync(path, lifetime.Token)),
                });
            }
            await api.SubmitResponseAsync(activeTask.Id, new ResponseBody
            {
                Markdown = markdown,
                Attachments = files,
            }, lifetime.Token);
            RemoveCache(activeTask.Id);
            activeTask = null;
            lastHeartbeatAt = null;
            answerBox.Text = "";
            responseFiles.Clear();
            UpdateResponseFilesLabel();
            connectionLabel.Text = "回答已回传，临时附件已删除";
            await PollAsync();
        }
        catch (Exception error)
        {
            submitButton.Enabled = true;
            if (!DiscardInactiveTask(taskId, error)) ShowError(error);
        }
    }

    private void SetCompactMode(bool value)
    {
        if (compact == value) return;
        if (value)
        {
            if (WindowState == FormWindowState.Normal) expandedBounds = Bounds;
            WindowState = FormWindowState.Normal;
            contentPanel.Visible = false;
            MinimumSize = new Size(360, 120);
            Size = new Size(500, 150);
            compactButton.Text = "展开";
        }
        else
        {
            contentPanel.Visible = true;
            MinimumSize = new Size(460, 420);
            if (expandedBounds.Width >= 460 && expandedBounds.Height >= 420) Bounds = expandedBounds;
            compactButton.Text = "收起悬浮窗";
        }
        compact = value;
    }

    private void ToggleZoom()
    {
        ShowWindow();
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
    }

    private void ResetWindowSize()
    {
        ShowWindow();
        WindowState = FormWindowState.Normal;
        Bounds = new Rectangle(
            Screen.FromControl(this).WorkingArea.Left + 80,
            Screen.FromControl(this).WorkingArea.Top + 40,
            compact ? 500 : 840,
            compact ? 150 : 780);
    }

    private void ShowWindow()
    {
        Show();
        WindowState = WindowState == FormWindowState.Minimized ? FormWindowState.Normal : WindowState;
        Activate();
        BringToFront();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (allowClose) return;
        eventArgs.Cancel = true;
        SaveWindowState();
        Hide();
    }

    private void Shutdown()
    {
        allowClose = true;
        SaveWindowState();
        pollTimer.Stop();
        lifetime.Cancel();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        api.Dispose();
        Close();
    }

    private void RestoreWindowState()
    {
        try
        {
            if (!File.Exists(WindowStatePath)) return;
            var state = JsonSerializer.Deserialize<WindowStateData>(File.ReadAllText(WindowStatePath));
            if (state is null) return;
            var candidate = new Rectangle(state.X, state.Y, Math.Max(state.Width, 460), Math.Max(state.Height, 420));
            var screen = Screen.AllScreens.FirstOrDefault(item => item.WorkingArea.IntersectsWith(candidate));
            if (screen is null) return;
            candidate.Width = Math.Min(candidate.Width, screen.WorkingArea.Width);
            candidate.Height = Math.Min(candidate.Height, screen.WorkingArea.Height);
            candidate.X = Math.Clamp(candidate.X, screen.WorkingArea.Left, screen.WorkingArea.Right - candidate.Width);
            candidate.Y = Math.Clamp(candidate.Y, screen.WorkingArea.Top, screen.WorkingArea.Bottom - candidate.Height);
            StartPosition = FormStartPosition.Manual;
            Bounds = candidate;
            expandedBounds = candidate;
            if (state.Maximized) WindowState = FormWindowState.Maximized;
        }
        catch { }
    }

    private void SaveWindowState()
    {
        try
        {
            Directory.CreateDirectory(AppDirectory);
            var bounds = compact && expandedBounds.Width >= 460 && expandedBounds.Height >= 420
                ? expandedBounds
                : WindowState == FormWindowState.Normal
                    ? Bounds
                    : RestoreBounds;
            File.WriteAllText(WindowStatePath, JsonSerializer.Serialize(new WindowStateData(
                bounds.X,
                bounds.Y,
                bounds.Width,
                bounds.Height,
                WindowState == FormWindowState.Maximized)));
        }
        catch { }
    }

    private void SelectTask(string taskId)
    {
        updatingPicker = true;
        for (var index = 0; index < taskPicker.Items.Count; index++)
        {
            if (taskPicker.Items[index] is TaskChoice choice && choice.Task.Id == taskId)
            {
                taskPicker.SelectedIndex = index;
                break;
            }
        }
        updatingPicker = false;
    }

    private static string CacheDirectory(string taskId) => Path.Combine(AppDirectory, "tasks", SafeFilename(taskId));

    private static void RemoveCache(string taskId)
    {
        var directory = CacheDirectory(taskId);
        try
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void CleanupCaches(HashSet<string> activeIds)
    {
        var root = Path.Combine(AppDirectory, "tasks");
        if (!Directory.Exists(root)) return;
        foreach (var directory in Directory.EnumerateDirectories(root))
            if (!activeIds.Contains(Path.GetFileName(directory)))
            {
                try { Directory.Delete(directory, true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
    }

    private static string SafeFilename(string value)
    {
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var safe = new string(value.Select(character => invalid.Contains(character) ? '-' : character).ToArray());
        return string.IsNullOrWhiteSpace(safe) ? "attachment.bin" : safe;
    }

    private static bool IsTextAttachment(RelayAttachment attachment)
    {
        if (attachment.MimeType?.StartsWith("text/", StringComparison.OrdinalIgnoreCase) == true) return true;
        return new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".txt", ".md", ".json", ".jsonl", ".js", ".jsx", ".ts", ".tsx", ".css", ".html",
            ".xml", ".yaml", ".yml", ".toml", ".csv", ".log", ".diff", ".patch", ".java", ".kt",
            ".gradle", ".properties", ".sql", ".sh", ".py", ".rb", ".go", ".rs", ".c", ".cpp", ".h", ".cs",
        }.Contains(Path.GetExtension(attachment.Filename));
    }

    private static bool IsImageAttachment(RelayAttachment attachment) =>
        attachment.MimeType?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) == true ||
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp" }
            .Contains(Path.GetExtension(attachment.Filename));

    private static string? MimeType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".txt" => "text/plain",
        ".md" => "text/markdown",
        ".json" => "application/json",
        ".pdf" => "application/pdf",
        ".zip" => "application/zip",
        _ => "application/octet-stream",
    };

    private static string FormatBytes(long bytes) => bytes switch
    {
        >= 1_073_741_824 => $"{bytes / 1_073_741_824d:0.0} GB",
        >= 1_048_576 => $"{bytes / 1_048_576d:0.0} MB",
        >= 1024 => $"{bytes / 1024d:0.0} KB",
        _ => $"{bytes} B",
    };

    private bool DiscardInactiveTask(string taskId, Exception error)
    {
        if (error is not HttpRequestException
            {
                StatusCode: System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Conflict,
            }) return false;
        RemoveCache(taskId);
        if (activeTask?.Id == taskId)
        {
            activeTask = null;
            lastHeartbeatAt = null;
            downloadedFiles.Clear();
            responseFiles.Clear();
            answerBox.Clear();
            UpdateResponseFilesLabel();
            UpdateUi();
        }
        connectionLabel.Text = "任务已在其他设备结束，已清除本地记录";
        return true;
    }

    private void ShowError(Exception error) =>
        MessageBox.Show(this, error.Message, "Oracle Relay", MessageBoxButtons.OK, MessageBoxIcon.Error);

    private sealed record TaskChoice(RelayTask Task)
    {
        public override string ToString() => $"[{Task.Status}] {Task.Title}";
    }
}
