package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import java.util.Objects;
import java.util.UUID;

public final class Claim {
    private final String id;
    private final UUID owner;
    private final String dimension;
    private final BlockPos min;
    private final BlockPos max;

    public Claim(String id, UUID owner, String dimension, BlockPos first, BlockPos second) {
        this.id = text(id, "id");
        this.owner = Objects.requireNonNull(owner, "owner");
        this.dimension = text(dimension, "dimension");
        Objects.requireNonNull(first, "first"); Objects.requireNonNull(second, "second");
        this.min = new BlockPos(Math.min(first.getX(), second.getX()), Math.min(first.getY(), second.getY()), Math.min(first.getZ(), second.getZ()));
        this.max = new BlockPos(Math.max(first.getX(), second.getX()), Math.max(first.getY(), second.getY()), Math.max(first.getZ(), second.getZ()));
        volume();
    }
    private static String text(String value, String name) {
        if (value == null || value.trim().isEmpty() || value.indexOf('\t') >= 0 || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) throw new IllegalArgumentException(name);
        return value;
    }
    public String getId() { return id; }
    public UUID getOwner() { return owner; }
    public String getDimension() { return dimension; }
    public BlockPos getMin() { return min; }
    public BlockPos getMax() { return max; }
    public boolean contains(String dimension, BlockPos position) {
        if (!this.dimension.equals(dimension) || position == null) return false;
        return position.getX() >= min.getX() && position.getX() <= max.getX()
            && position.getY() >= min.getY() && position.getY() <= max.getY()
            && position.getZ() >= min.getZ() && position.getZ() <= max.getZ();
    }
    public boolean overlaps(Claim other) {
        Objects.requireNonNull(other, "other");
        return dimension.equals(other.dimension)
            && min.getX() <= other.max.getX() && max.getX() >= other.min.getX()
            && min.getY() <= other.max.getY() && max.getY() >= other.min.getY()
            && min.getZ() <= other.max.getZ() && max.getZ() >= other.min.getZ();
    }
    public long volume() {
        long x = (long) max.getX() - min.getX() + 1L;
        long y = (long) max.getY() - min.getY() + 1L;
        long z = (long) max.getZ() - min.getZ() + 1L;
        try { return Math.multiplyExact(Math.multiplyExact(x, y), z); }
        catch (ArithmeticException error) { throw new IllegalArgumentException("claim volume overflows long", error); }
    }
    public String serialize() {
        return id + "\t" + owner + "\t" + dimension + "\t" + min.getX() + "\t" + min.getY() + "\t" + min.getZ() + "\t" + max.getX() + "\t" + max.getY() + "\t" + max.getZ();
    }
    public static Claim deserialize(String record) {
        if (record == null) throw new IllegalArgumentException("record");
        String[] fields = record.split("\\t", -1);
        if (fields.length != 9) throw new IllegalArgumentException("malformed claim record");
        try {
            int minX = Integer.parseInt(fields[3]); int minY = Integer.parseInt(fields[4]); int minZ = Integer.parseInt(fields[5]);
            int maxX = Integer.parseInt(fields[6]); int maxY = Integer.parseInt(fields[7]); int maxZ = Integer.parseInt(fields[8]);
            if (minX > maxX || minY > maxY || minZ > maxZ) throw new IllegalArgumentException("unnormalized claim record");
            return new Claim(fields[0], UUID.fromString(fields[1]), fields[2],
                new BlockPos(minX, minY, minZ), new BlockPos(maxX, maxY, maxZ));
        } catch (RuntimeException error) { throw new IllegalArgumentException("malformed claim record", error); }
    }
}
