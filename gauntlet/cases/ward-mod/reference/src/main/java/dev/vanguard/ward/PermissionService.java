package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import dev.vanguard.ward.api.PlayerContext;
import java.util.Collections;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

public final class PermissionService {
    private final ClaimStore store;
    private final Set<UUID> bypass = Collections.synchronizedSet(new HashSet<UUID>());
    public PermissionService(ClaimStore store) { if (store == null) throw new IllegalArgumentException("store"); this.store = store; }
    public boolean canBuild(PlayerContext player, String dimension, BlockPos position) {
        if (player == null || dimension == null || position == null) throw new IllegalArgumentException("build context");
        Optional<Claim> claim = store.findAt(dimension, position);
        return !claim.isPresent() || player.isAdministrator() || hasBypass(player.getId()) || claim.get().getOwner().equals(player.getId());
    }
    public void grantBypass(UUID player) { if (player == null) throw new IllegalArgumentException("player"); bypass.add(player); }
    public void revokeBypass(UUID player) { if (player == null) throw new IllegalArgumentException("player"); bypass.remove(player); }
    public boolean hasBypass(UUID player) { return player != null && bypass.contains(player); }
}
