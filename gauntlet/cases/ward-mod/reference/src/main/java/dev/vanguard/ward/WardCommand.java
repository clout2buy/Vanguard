package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import dev.vanguard.ward.api.PlayerContext;
import java.util.List;
import java.util.Optional;

public final class WardCommand {
    private final ClaimStore store;
    public WardCommand(ClaimStore store) { if (store == null) throw new IllegalArgumentException("store"); this.store = store; }
    public CommandResult execute(PlayerContext player, String input) {
        if (player == null) return CommandResult.failure("Missing player context");
        if (input == null || input.trim().isEmpty()) return CommandResult.failure("Usage: claim, unclaim, info, or list");
        String[] parts = input.trim().split("\\s+");
        try {
            if ("claim".equalsIgnoreCase(parts[0])) {
                if (parts.length != 7) return CommandResult.failure("Usage: claim x1 y1 z1 x2 y2 z2");
                int[] n = new int[6]; for (int i = 0; i < n.length; i++) n[i] = Integer.parseInt(parts[i + 1]);
                Claim value = store.claim(player.getId(), player.getDimension(), new BlockPos(n[0], n[1], n[2]), new BlockPos(n[3], n[4], n[5]));
                return CommandResult.success("Created claim " + value.getId());
            }
            if ("unclaim".equalsIgnoreCase(parts[0])) {
                if (parts.length != 2) return CommandResult.failure("Usage: unclaim ID");
                return store.remove(parts[1], player.getId(), player.isAdministrator())
                    ? CommandResult.success("Removed claim " + parts[1]) : CommandResult.failure("Unknown claim " + parts[1]);
            }
            if ("info".equalsIgnoreCase(parts[0])) {
                if (parts.length != 1) return CommandResult.failure("Usage: info");
                Optional<Claim> value = store.findAt(player.getDimension(), player.getPosition());
                return value.isPresent() ? CommandResult.success(value.get().getId() + " owned by " + value.get().getOwner()) : CommandResult.success("Wilderness");
            }
            if ("list".equalsIgnoreCase(parts[0])) {
                if (parts.length != 1) return CommandResult.failure("Usage: list");
                List<Claim> values = store.list(player.getId());
                StringBuilder message = new StringBuilder(); for (Claim value : values) { if (message.length() > 0) message.append(", "); message.append(value.getId()); }
                return CommandResult.success(message.length() == 0 ? "No claims" : message.toString());
            }
            return CommandResult.failure("Unknown ward command");
        } catch (NumberFormatException error) { return CommandResult.failure("Coordinates must be integers"); }
        catch (RuntimeException error) { return CommandResult.failure(error.getMessage() == null ? "Command failed" : error.getMessage()); }
    }
}
