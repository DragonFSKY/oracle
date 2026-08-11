using System.Text.Json.Serialization;

namespace OracleRelayOperator;

internal static class RelayConfig
{
    internal static string Url => RequiredEnvironment("ORACLE_RELAY_OPERATOR_URL");
    internal static string OperatorToken => RequiredEnvironment("ORACLE_RELAY_OPERATOR_TOKEN");

    private static string RequiredEnvironment(string name)
    {
        var value = Environment.GetEnvironmentVariable(name)?.Trim();
        return !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidOperationException($"Missing required environment variable {name}.");
    }

    internal static string OperatorName
    {
        get
        {
            var machine = new string(Environment.MachineName
                .Where(character => char.IsLetterOrDigit(character) || character is '-' or '_')
                .ToArray());
            return $"windows-{(string.IsNullOrWhiteSpace(machine) ? "device" : machine)}";
        }
    }
}

internal sealed class RelayAttachment
{
    public string Id { get; set; } = "";
    public string Filename { get; set; } = "";
    public string DisplayPath { get; set; } = "";
    public string? MimeType { get; set; }
    public long SizeBytes { get; set; }
    public string Sha256 { get; set; } = "";
    public string Direction { get; set; } = "";
}

internal sealed class RelayTaskResponse
{
    public string Markdown { get; set; } = "";
    public string? SubmittedBy { get; set; }
    public string SubmittedAt { get; set; } = "";
    public List<RelayAttachment> Attachments { get; set; } = [];
}

internal sealed class RelayTask
{
    public string Id { get; set; } = "";
    public string Status { get; set; } = "";
    public string Title { get; set; } = "";
    public string Prompt { get; set; } = "";
    public string? ModelHint { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
    public string? ClaimedBy { get; set; }
    public List<RelayAttachment> Attachments { get; set; } = [];
    public RelayTaskResponse? Response { get; set; }
}

internal sealed class OperatorBody
{
    [JsonPropertyName("operator")]
    public string Operator { get; init; } = RelayConfig.OperatorName;
}

internal sealed class ResponseFileBody
{
    public string Filename { get; init; } = "";
    public string? MimeType { get; init; }
    public string ContentBase64 { get; init; } = "";
}

internal sealed class ResponseBody
{
    [JsonPropertyName("operator")]
    public string Operator { get; init; } = RelayConfig.OperatorName;
    public string Markdown { get; init; } = "";
    public List<ResponseFileBody> Attachments { get; init; } = [];
}

internal sealed record WindowStateData(int X, int Y, int Width, int Height, bool Maximized);
