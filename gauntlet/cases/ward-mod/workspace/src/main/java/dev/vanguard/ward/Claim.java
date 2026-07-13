package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import java.util.UUID;

public final class Claim {
    public Claim(String id, UUID owner, String dimension, BlockPos first, BlockPos second) {
        throw new UnsupportedOperationException("TODO");
    }
    public String getId() { return null; }
    public UUID getOwner() { return null; }
    public String getDimension() { return null; }
    public BlockPos getMin() { return null; }
    public BlockPos getMax() { return null; }
    public boolean contains(String dimension, BlockPos position) { return false; }
    public boolean overlaps(Claim other) { return false; }
    public long volume() { return 0L; }
    public String serialize() { return ""; }
    public static Claim deserialize(String record) { throw new UnsupportedOperationException("TODO"); }
}
