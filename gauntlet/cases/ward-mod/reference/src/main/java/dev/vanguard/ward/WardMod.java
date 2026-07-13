package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import dev.vanguard.ward.api.PlayerContext;

public final class WardMod {
    private final ClaimStore store;
    private final PermissionService permissions;
    private final WardCommand commands;
    public WardMod() { this(8); }
    public WardMod(int maxClaimsPerOwner) {
        store = new ClaimStore(maxClaimsPerOwner);
        permissions = new PermissionService(store);
        commands = new WardCommand(store);
    }
    public ClaimStore getStore() { return store; }
    public PermissionService getPermissions() { return permissions; }
    public CommandResult execute(PlayerContext player, String input) { return commands.execute(player, input); }
    public boolean onBlockPlace(PlayerContext player, String dimension, BlockPos position) { return permissions.canBuild(player, dimension, position); }
    public boolean onBlockBreak(PlayerContext player, String dimension, BlockPos position) { return permissions.canBuild(player, dimension, position); }
}
