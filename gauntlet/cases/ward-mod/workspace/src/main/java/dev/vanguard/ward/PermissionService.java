package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import dev.vanguard.ward.api.PlayerContext;
import java.util.UUID;

public final class PermissionService {
    public PermissionService(ClaimStore store) { throw new UnsupportedOperationException("TODO"); }
    public boolean canBuild(PlayerContext player, String dimension, BlockPos position) { return false; }
    public void grantBypass(UUID player) { throw new UnsupportedOperationException("TODO"); }
    public void revokeBypass(UUID player) { throw new UnsupportedOperationException("TODO"); }
    public boolean hasBypass(UUID player) { return false; }
}
