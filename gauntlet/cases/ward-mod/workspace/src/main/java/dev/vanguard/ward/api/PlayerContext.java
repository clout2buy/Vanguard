package dev.vanguard.ward.api;

import java.util.Objects;
import java.util.UUID;

public final class PlayerContext {
    private final UUID id;
    private final String dimension;
    private final BlockPos position;
    private final boolean administrator;

    public PlayerContext(UUID id, String dimension, BlockPos position, boolean administrator) {
        this.id = Objects.requireNonNull(id, "id");
        this.dimension = Objects.requireNonNull(dimension, "dimension");
        this.position = Objects.requireNonNull(position, "position");
        this.administrator = administrator;
    }
    public UUID getId() { return id; }
    public String getDimension() { return dimension; }
    public BlockPos getPosition() { return position; }
    public boolean isAdministrator() { return administrator; }
}
