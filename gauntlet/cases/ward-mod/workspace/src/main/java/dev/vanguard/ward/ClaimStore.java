package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public final class ClaimStore {
    public ClaimStore(int maxClaimsPerOwner) { throw new UnsupportedOperationException("TODO"); }
    public synchronized Claim claim(UUID owner, String dimension, BlockPos first, BlockPos second) { throw new UnsupportedOperationException("TODO"); }
    public synchronized Optional<Claim> findAt(String dimension, BlockPos position) { return Optional.empty(); }
    public synchronized Optional<Claim> findById(String id) { return Optional.empty(); }
    public synchronized List<Claim> list(UUID owner) { return Collections.emptyList(); }
    public synchronized List<Claim> all() { return Collections.emptyList(); }
    public synchronized boolean remove(String id, UUID actor, boolean administrator) { return false; }
    public synchronized void save(Path destination) throws IOException { throw new UnsupportedOperationException("TODO"); }
    public static ClaimStore load(Path source, int maxClaimsPerOwner) throws IOException { throw new UnsupportedOperationException("TODO"); }
}
