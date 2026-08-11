using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

namespace OracleRelayOperator;

internal sealed class RelayApi : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient client;
    private readonly Func<string> language;

    internal RelayApi(Func<string>? language = null)
    {
        this.language = language ?? (() => "system");
        var handler = new HttpClientHandler
        {
            // The Relay endpoint is public HTTPS. A stale desktop proxy must not
            // silently strand this dedicated operator client on localhost.
            UseProxy = false,
        };
        client = new HttpClient(handler)
        {
            BaseAddress = new Uri(RelayConfig.Url.TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromMinutes(3),
        };
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", RelayConfig.OperatorToken);
        client.DefaultRequestHeaders.UserAgent.ParseAdd("OracleRelayOperator-Windows/0.2.3");
    }

    internal Task<List<RelayTask>> GetTasksAsync(CancellationToken cancellationToken) =>
        GetAsync<List<RelayTask>>("v1/tasks", cancellationToken);

    internal Task<RelayTask> GetTaskAsync(string taskId, CancellationToken cancellationToken) =>
        GetAsync<RelayTask>($"v1/tasks/{Escape(taskId)}", cancellationToken);

    internal Task<RelayTask> ClaimAsync(string taskId, CancellationToken cancellationToken) =>
        PostAsync<RelayTask>($"v1/tasks/{Escape(taskId)}/claim", new OperatorBody(), cancellationToken);

    internal Task<RelayTask> MarkSubmittedAsync(string taskId, CancellationToken cancellationToken) =>
        PostAsync<RelayTask>($"v1/tasks/{Escape(taskId)}/submitted", new OperatorBody(), cancellationToken);

    internal Task<RelayTask> HeartbeatAsync(string taskId, CancellationToken cancellationToken) =>
        PostAsync<RelayTask>($"v1/tasks/{Escape(taskId)}/heartbeat", new OperatorBody(), cancellationToken);

    internal Task<RelayTask> AbortAsync(string taskId, CancellationToken cancellationToken) =>
        PostAsync<RelayTask>($"v1/tasks/{Escape(taskId)}/abort", new OperatorBody(), cancellationToken);

    internal Task<RelayTask> SubmitResponseAsync(
        string taskId,
        ResponseBody response,
        CancellationToken cancellationToken) =>
        PostAsync<RelayTask>($"v1/tasks/{Escape(taskId)}/response", response, cancellationToken);

    internal async Task DownloadAttachmentAsync(
        string taskId,
        RelayAttachment attachment,
        string destination,
        CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(
            $"v1/tasks/{Escape(taskId)}/attachments/{Escape(attachment.Id)}",
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = $"{destination}.{Guid.NewGuid():N}.part";
        try
        {
            await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var output = new FileStream(
                temporary,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                81920,
                FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                await input.CopyToAsync(output, cancellationToken);
            }

            var info = new FileInfo(temporary);
            if (info.Length != attachment.SizeBytes)
            {
                throw new InvalidDataException(T("attachment.size-invalid", ("filename", attachment.Filename)));
            }
            await using var file = File.OpenRead(temporary);
            var digest = Convert.ToHexString(await SHA256.HashDataAsync(file, cancellationToken)).ToLowerInvariant();
            if (!digest.Equals(attachment.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(T("attachment.checksum-invalid", ("filename", attachment.Filename)));
            }
            try
            {
                File.Move(temporary, destination, true);
            }
            catch (IOException) when (
                File.Exists(destination) && new FileInfo(destination).Length == attachment.SizeBytes)
            {
                // Another overlapping refresh finished the same verified download first.
            }
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private async Task<T> GetAsync<T>(string path, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(path, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken)
            ?? throw new InvalidDataException(T("error.empty-response"));
    }

    private async Task<T> PostAsync<T>(string path, object body, CancellationToken cancellationToken)
    {
        using var response = await client.PostAsJsonAsync(path, body, JsonOptions, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken)
            ?? throw new InvalidDataException(T("error.empty-response"));
    }

    private async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new HttpRequestException(
            T("error.request", ("status", (int)response.StatusCode), ("detail", string.IsNullOrWhiteSpace(body) ? response.ReasonPhrase ?? "" : body)),
            null,
            response.StatusCode);
    }

    private static string Escape(string value) => Uri.EscapeDataString(value);

    private string T(string key, params (string Name, object Value)[] values) => OperatorLocale.T(key, language(), values);

    public void Dispose() => client.Dispose();
}
