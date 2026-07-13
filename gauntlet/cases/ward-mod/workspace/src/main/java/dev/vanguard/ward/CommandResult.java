package dev.vanguard.ward;

public final class CommandResult {
    private final boolean success;
    private final String message;
    private CommandResult(boolean success, String message) { this.success = success; this.message = message; }
    public static CommandResult success(String message) { return new CommandResult(true, message); }
    public static CommandResult failure(String message) { return new CommandResult(false, message); }
    public boolean isSuccess() { return success; }
    public String getMessage() { return message; }
}
