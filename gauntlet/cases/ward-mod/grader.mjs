import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const workspace = path.resolve(process.argv[2] ?? ".");
const sourceRoot = path.join(workspace, "src", "main", "java");
const temporary = await mkdtemp(path.join(os.tmpdir(), "vanguard-ward-grader-"));
const classes = path.join(temporary, "classes");
await mkdir(classes);

const harness = `
import dev.vanguard.ward.*;
import dev.vanguard.ward.api.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public final class WardHarness {
  private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
  private static void rejects(Runnable action, String message) { try { action.run(); } catch (RuntimeException expected) { return; } throw new AssertionError(message); }
  public static void main(String[] args) throws Exception {
    UUID owner = UUID.fromString("00000000-0000-0000-0000-000000000001");
    UUID stranger = UUID.fromString("00000000-0000-0000-0000-000000000002");
    Claim normalized = new Claim("manual", owner, "overworld", new BlockPos(2, 4, 6), new BlockPos(0, 1, 3));
    check(normalized.getMin().getX() == 0 && normalized.getMax().getZ() == 6, "corners normalize");
    check(normalized.contains("overworld", new BlockPos(2, 4, 6)), "inclusive contains");
    check(!normalized.contains("nether", new BlockPos(2, 4, 6)), "dimension-aware contains");
    check(normalized.volume() == 48L, "exact inclusive volume");
    check(Claim.deserialize(normalized.serialize()).serialize().equals(normalized.serialize()), "persistence round trip");
    rejects(() -> Claim.deserialize("bad"), "malformed record rejected");
    rejects(() -> new Claim("bad\\tid", owner, "overworld", new BlockPos(0, 0, 0), new BlockPos(0, 0, 0)), "tabbed id rejected");
    rejects(() -> new Claim("id", owner, "bad\\ndimension", new BlockPos(0, 0, 0), new BlockPos(0, 0, 0)), "line-separated dimension rejected");
    rejects(() -> new Claim("huge", owner, "overworld", new BlockPos(Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE), new BlockPos(Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE)), "overflow rejected");

    ClaimStore store = new ClaimStore(2);
    Claim first = store.claim(owner, "overworld", new BlockPos(0, 0, 0), new BlockPos(2, 2, 2));
    check(first.getId().equals("C000001"), "first stable id");
    rejects(() -> store.claim(stranger, "overworld", new BlockPos(2, 2, 2), new BlockPos(4, 4, 4)), "touching overlap rejected");
    Claim second = store.claim(owner, "overworld", new BlockPos(3, 0, 0), new BlockPos(4, 1, 1));
    check(second.getId().equals("C000002"), "failed claim does not consume id");
    store.claim(stranger, "nether", new BlockPos(0, 0, 0), new BlockPos(2, 2, 2));
    rejects(() -> store.claim(owner, "overworld", new BlockPos(10, 0, 0), new BlockPos(11, 1, 1)), "owner limit enforced");
    try { store.all().clear(); throw new AssertionError("snapshot immutable"); } catch (UnsupportedOperationException expected) {}
    boolean unauthorizedRemoval = false;
    try { unauthorizedRemoval = store.remove(first.getId(), stranger, false); } catch (SecurityException acceptable) {}
    check(!unauthorizedRemoval && store.findById(first.getId()).isPresent(), "stranger cannot remove");

    PermissionService permissions = new PermissionService(store);
    PlayerContext ownerContext = new PlayerContext(owner, "overworld", new BlockPos(1, 1, 1), false);
    PlayerContext strangerContext = new PlayerContext(stranger, "overworld", new BlockPos(1, 1, 1), false);
    check(permissions.canBuild(ownerContext, "overworld", new BlockPos(1, 1, 1)), "owner allowed");
    check(!permissions.canBuild(strangerContext, "overworld", new BlockPos(1, 1, 1)), "stranger denied");
    check(permissions.canBuild(strangerContext, "overworld", new BlockPos(99, 1, 1)), "wilderness allowed");
    permissions.grantBypass(stranger); check(permissions.canBuild(strangerContext, "overworld", new BlockPos(1, 1, 1)), "bypass allowed");
    permissions.revokeBypass(stranger); check(!permissions.hasBypass(stranger), "bypass revoked");
    List<UUID> concurrentBypass = new ArrayList<UUID>();
    for (int i = 0; i < 1200; i++) concurrentBypass.add(new UUID(7L, i + 10L));
    List<Thread> workers = new ArrayList<Thread>();
    for (int worker = 0; worker < 8; worker++) {
      final int offset = worker;
      Thread thread = new Thread(() -> { for (int i = offset; i < concurrentBypass.size(); i += 8) permissions.grantBypass(concurrentBypass.get(i)); });
      workers.add(thread); thread.start();
    }
    for (Thread thread : workers) thread.join();
    for (UUID id : concurrentBypass) check(permissions.hasBypass(id), "concurrent bypass update retained");

    ClaimStore commandStore = new ClaimStore(3);
    WardCommand command = new WardCommand(commandStore);
    check(!command.execute(ownerContext, "claim 1 nope 3 4 5 6").isSuccess(), "bad coordinates are user errors");
    check(commandStore.all().isEmpty(), "parse failure cannot mutate");
    CommandResult created = command.execute(ownerContext, "  claim 0 0 0 1 1 1  ");
    check(created.isSuccess() && created.getMessage().contains("C000001"), "claim command");
    check(command.execute(ownerContext, "info").isSuccess(), "info command");
    check(command.execute(ownerContext, "list").getMessage().contains("C000001"), "list command");
    check(command.execute(ownerContext, "unclaim C000001").isSuccess() && commandStore.all().isEmpty(), "unclaim command");
    check(!command.execute(ownerContext, "unknown").isSuccess(), "unknown command is safe");

    Path data = Paths.get(args[0], "nested", "data", "claims.tsv");
    check(ClaimStore.load(Paths.get(args[0], "missing.tsv"), 3).all().isEmpty(), "missing store loads empty");
    store.save(data);
    List<String> lines = Files.readAllLines(data, StandardCharsets.UTF_8);
    List<String> sorted = new ArrayList<String>(lines); Collections.sort(sorted);
    check(lines.equals(sorted), "deterministic persistence order");
    ClaimStore loaded = ClaimStore.load(data, 3);
    check(loaded.all().size() == 3, "load all claims");
    Claim next = loaded.claim(stranger, "end", new BlockPos(0, 0, 0), new BlockPos(0, 0, 0));
    check(next.getId().equals("C000004"), "ids continue after load");
    Files.write(data, Arrays.asList(lines.get(0), lines.get(0)), StandardCharsets.UTF_8);
    try { ClaimStore.load(data, 3); throw new AssertionError("duplicate persistence rejected"); } catch (java.io.IOException expected) {}
    Files.write(data, Arrays.asList(lines.get(0).replaceFirst("^C[0-9]+", "C1")), StandardCharsets.UTF_8);
    try { ClaimStore.load(data, 3); throw new AssertionError("noncanonical id rejected"); } catch (Exception expected) {}

    WardMod mod = new WardMod(2);
    mod.getStore().claim(owner, "overworld", new BlockPos(0, 0, 0), new BlockPos(1, 1, 1));
    check(!mod.onBlockPlace(strangerContext, "overworld", new BlockPos(0, 0, 0)), "place policy wired");
    check(!mod.onBlockBreak(strangerContext, "overworld", new BlockPos(0, 0, 0)), "break policy wired");
    check(mod.execute(ownerContext, "list").isSuccess(), "command handler wired");
  }
}
`;

try {
  const harnessFile = path.join(temporary, "WardHarness.java");
  await writeFile(harnessFile, harness);
  const sources = await javaFiles(sourceRoot);
  const compilation = await execute("javac", ["-encoding", "UTF-8", "-source", "8", "-target", "8", "-d", classes, ...sources, harnessFile], { maxBuffer: 5_000_000 });
  assert.equal(compilation.stderr.includes("error:"), false, compilation.stderr);
  await execute("java", ["-ea", "-cp", classes, "WardHarness", temporary], { maxBuffer: 5_000_000 });

  const metadata = JSON.parse(await readFile(path.join(workspace, "src", "main", "resources", "fabric.mod.json"), "utf8"));
  assert.equal(metadata.id, "ward"); assert.equal(metadata.name, "Ward"); assert.equal(metadata.version, "1.0.0");
  assert.ok(metadata.entrypoints?.main?.includes("dev.vanguard.ward.WardMod"));
  const lang = JSON.parse(await readFile(path.join(workspace, "src", "main", "resources", "assets", "ward", "lang", "en_us.json"), "utf8"));
  for (const key of ["ward.claim.created", "ward.claim.overlap", "ward.claim.limit", "ward.build.denied"]) {
    assert.equal(typeof lang[key], "string"); assert.ok(lang[key].trim());
  }
  console.log("ward-mod: sealed grader passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function javaFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await javaFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".java")) output.push(absolute);
  }
  return output.sort();
}
