package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import dev.vanguard.ward.api.PlayerContext;

public final class WardMod {
    public WardMod() { this(8); }
    public WardMod(int maxClaimsPerOwner) { throw new UnsupportedOperationException("TODO"); }
    public ClaimStore getStore() { return null; }
    public PermissionService getPermissions() { return null; }
    public CommandResult execute(PlayerContext player, String input) { return CommandResult.failure("TODO"); }
    public boolean onBlockPlace(PlayerContext player, String dimension, BlockPos position) { return false; }
    public boolean onBlockBreak(PlayerContext player, String dimension, BlockPos position) { return false; }
}
