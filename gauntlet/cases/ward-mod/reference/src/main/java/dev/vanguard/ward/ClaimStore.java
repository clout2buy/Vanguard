package dev.vanguard.ward;

import dev.vanguard.ward.api.BlockPos;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public final class ClaimStore {
    private final int maxClaimsPerOwner;
    private final Map<String, Claim> claims = new LinkedHashMap<String, Claim>();
    private long nextId = 1L;

    public ClaimStore(int maxClaimsPerOwner) {
        if (maxClaimsPerOwner <= 0) throw new IllegalArgumentException("maxClaimsPerOwner");
        this.maxClaimsPerOwner = maxClaimsPerOwner;
    }
    public synchronized Claim claim(UUID owner, String dimension, BlockPos first, BlockPos second) {
        if (owner == null) throw new IllegalArgumentException("owner");
        int owned = 0; for (Claim value : claims.values()) if (value.getOwner().equals(owner)) owned++;
        if (owned >= maxClaimsPerOwner) throw new IllegalStateException("claim limit reached");
        Claim candidate = new Claim(formatId(nextId), owner, dimension, first, second);
        for (Claim value : claims.values()) if (value.overlaps(candidate)) throw new IllegalStateException("claim overlaps " + value.getId());
        nextId++;
        claims.put(candidate.getId(), candidate);
        return candidate;
    }
    public synchronized Optional<Claim> findAt(String dimension, BlockPos position) {
        for (Claim value : claims.values()) if (value.contains(dimension, position)) return Optional.of(value);
        return Optional.empty();
    }
    public synchronized Optional<Claim> findById(String id) { return Optional.ofNullable(claims.get(id)); }
    public synchronized List<Claim> list(UUID owner) {
        List<Claim> result = new ArrayList<Claim>();
        for (Claim value : claims.values()) if (value.getOwner().equals(owner)) result.add(value);
        Collections.sort(result, Comparator.comparing(Claim::getId));
        return Collections.unmodifiableList(result);
    }
    public synchronized List<Claim> all() {
        List<Claim> result = new ArrayList<Claim>(claims.values());
        Collections.sort(result, Comparator.comparing(Claim::getId));
        return Collections.unmodifiableList(result);
    }
    public synchronized boolean remove(String id, UUID actor, boolean administrator) {
        if (actor == null) throw new IllegalArgumentException("actor");
        Claim value = claims.get(id);
        if (value == null) return false;
        if (!administrator && !value.getOwner().equals(actor)) throw new SecurityException("not claim owner");
        claims.remove(id); return true;
    }
    public synchronized void save(Path destination) throws IOException {
        if (destination == null) throw new IllegalArgumentException("destination");
        Path absolute = destination.toAbsolutePath();
        Path parent = absolute.getParent(); if (parent != null) Files.createDirectories(parent);
        Path temporary = absolute.resolveSibling(absolute.getFileName() + ".tmp-" + UUID.randomUUID());
        List<String> lines = new ArrayList<String>(); for (Claim value : all()) lines.add(value.serialize());
        try {
            Files.write(temporary, lines, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            try { Files.move(temporary, absolute, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException error) { Files.move(temporary, absolute, StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temporary); }
    }
    public static ClaimStore load(Path source, int maxClaimsPerOwner) throws IOException {
        ClaimStore loaded = new ClaimStore(maxClaimsPerOwner);
        if (!Files.exists(source)) return loaded;
        long greatest = 0L;
        try {
            for (String line : Files.readAllLines(source, StandardCharsets.UTF_8)) {
                if (line.trim().isEmpty()) throw new IllegalArgumentException("blank record");
                Claim claim = Claim.deserialize(line);
                if (loaded.claims.containsKey(claim.getId())) throw new IllegalArgumentException("duplicate id");
                int count = 0; for (Claim value : loaded.claims.values()) {
                    if (value.overlaps(claim)) throw new IllegalArgumentException("overlap");
                    if (value.getOwner().equals(claim.getOwner())) count++;
                }
                if (count >= maxClaimsPerOwner) throw new IllegalArgumentException("claim limit");
                if (!claim.getId().matches("C[0-9]+")) throw new IllegalArgumentException("invalid id");
                greatest = Math.max(greatest, Long.parseLong(claim.getId().substring(1)));
                loaded.claims.put(claim.getId(), claim);
            }
        } catch (RuntimeException error) { throw new IOException("corrupt claim store", error); }
        loaded.nextId = Math.addExact(greatest, 1L);
        return loaded;
    }
    private static String formatId(long value) { return String.format("C%06d", value); }
}
