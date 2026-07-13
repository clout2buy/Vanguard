import dev.vanguard.ward.*;
import dev.vanguard.ward.api.*;
import java.util.*;

public final class PublicWardHarness {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void rejects(Runnable action, String message) { try { action.run(); } catch (RuntimeException expected) { return; } throw new AssertionError(message); }
    public static void main(String[] args) {
        UUID owner = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID stranger = UUID.fromString("00000000-0000-0000-0000-000000000002");
        Claim shape = new Claim("manual", owner, "overworld", new BlockPos(2, 2, 2), new BlockPos(0, 0, 0));
        check(shape.volume() == 27L && shape.contains("overworld", new BlockPos(0, 0, 0)), "inclusive normalized claim");
        rejects(() -> new Claim("huge", owner, "overworld", new BlockPos(Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE), new BlockPos(Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE)), "overflow rejected");
        check(Claim.deserialize(shape.serialize()).serialize().equals(shape.serialize()), "claim persistence round trip");

        ClaimStore store = new ClaimStore(2);
        Claim first = store.claim(owner, "overworld", new BlockPos(0, 0, 0), new BlockPos(2, 2, 2));
        rejects(() -> store.claim(stranger, "overworld", new BlockPos(2, 2, 2), new BlockPos(3, 3, 3)), "inclusive overlap rejected");
        boolean removed = false; try { removed = store.remove(first.getId(), stranger, false); } catch (SecurityException acceptable) {}
        check(!removed && store.findById(first.getId()).isPresent(), "unauthorized removal denied");
        try { store.all().clear(); throw new AssertionError("immutable snapshot"); } catch (UnsupportedOperationException expected) {}

        PlayerContext strangerContext = new PlayerContext(stranger, "overworld", new BlockPos(1, 1, 1), false);
        PermissionService permissions = new PermissionService(store);
        check(!permissions.canBuild(strangerContext, "overworld", new BlockPos(1, 1, 1)), "claimed build denied");
        check(permissions.canBuild(strangerContext, "overworld", new BlockPos(20, 1, 1)), "wilderness build allowed");

        ClaimStore commands = new ClaimStore(2);
        WardCommand command = new WardCommand(commands);
        check(!command.execute(strangerContext, "claim 1 nope 3 4 5 6").isSuccess() && commands.all().isEmpty(), "malformed command cannot mutate");
        check(command.execute(strangerContext, "claim 0 0 0 1 1 1").isSuccess(), "claim command works");
    }
}
