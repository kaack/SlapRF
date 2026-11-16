import {
  buildRoundNetworkGraph,
  buildStageNetworkGraph,
} from "../core/connection_graph";
import { RaceHeat, RoundConnection } from "../types/models";
import {
  describe,
  expect,
  it,
  makeEventPilot,
  makeHeat,
  makeRaceState,
  makeRound,
  makeStage,
} from "./harness";

describe("core/connection_graph — StageNetworkGraph (Format DAG)", () => {
  it("allows valid forward & diamond stage connections while blocking self-loops, duplicates, and multi-hop cycles", () => {
    const s1 = makeStage(1, { id: "s1", title: "Qualifying", format: "qualifying" });
    const s2 = makeStage(2, { id: "s2", title: "Winners Bracket", format: "double_elimination" });
    const s3 = makeStage(3, { id: "s3", title: "Redemption", format: "single_elimination" });
    const s4 = makeStage(4, { id: "s4", title: "Grand Finals", format: "chase_the_ace" });

    const race = makeRaceState({
      stages: [s1, s2, s3, s4],
      stageConnections: [
        { id: "sc-1", fromStageId: "s1", toStageId: "s2", fromStageIndex: 1, toStageIndex: 2, mode: "top_n", count: 8 },
        { id: "sc-2", fromStageId: "s2", toStageId: "s3", fromStageIndex: 2, toStageIndex: 3, mode: "seed_range", seedStart: 5, seedEnd: 8 },
      ],
      heats: [],
    });

    const graph = buildStageNetworkGraph([s1, s2, s3, s4], race);

    // Self-loop blocked
    const selfRes = graph.validateConnection("s2", "s2");
    expect(selfRes.valid).toBe(false);
    expect(selfRes.reason).toContain("cannot connect to itself");

    // Duplicate blocked
    const dupRes = graph.validateConnection("s1", "s2");
    expect(dupRes.valid).toBe(false);
    expect(dupRes.reason).toContain("already connected");

    // Direct 2-hop & 3-hop cycles blocked (s1 -> s2 -> s3 => s3 -> s2 and s3 -> s1 create loops)
    const cycleRes = graph.validateConnection("s3", "s2");
    expect(cycleRes.valid).toBe(false);
    expect(cycleRes.reason).toContain("dependency loop");

    // Connecting into a starting qualifier stage is blocked
    const qualTargetRes = graph.validateConnection("s2", "s1");
    expect(qualTargetRes.valid).toBe(false);
    // Note: s2 -> s1 is also a cycle because s1 -> s2 exists; test an unconnected qualifier too:
    const s5Qual = makeStage(5, { id: "s5", title: "Open Qual", format: "open_qualifier" });
    const graphWithQual = buildStageNetworkGraph([s1, s2, s5Qual], race);
    const intoOpenQual = graphWithQual.validateConnection("s2", "s5");
    expect(intoOpenQual.valid).toBe(false);
    expect(intoOpenQual.reason).toContain("starting qualifier stage");

    // Diamond DAG branches (s2 -> s4 and s3 -> s4) are valid!
    expect(graph.validateConnection("s2", "s4").valid).toBe(true);
    expect(graph.validateConnection("s3", "s4").valid).toBe(true);
    expect(graph.getValidTargetIds("s1")).toEqual(new Set(["s3", "s4"]));
  });

  it("ignores invalid wires for reachability, respects excludeConnectionId on reconnect, and locks started target stages", () => {
    const s1 = makeStage(1, { id: "s1", title: "Stage 1", format: "qualifying" });
    const s2 = makeStage(2, { id: "s2", title: "Stage 2", format: "single_elimination" });
    const s3 = makeStage(3, { id: "s3", title: "Stage 3", format: "points_mains" });

    const race = makeRaceState({
      stages: [s1, s2, s3],
      stageConnections: [
        // Pre-existing invalid wire s2 -> s3 should NOT count toward reachability cycles
        { id: "bad-wire", fromStageId: "s3", toStageId: "s2", fromStageIndex: 3, toStageIndex: 2, mode: "all_pilots", invalid: true },
        { id: "good-wire", fromStageId: "s1", toStageId: "s2", fromStageIndex: 1, toStageIndex: 2, mode: "all_pilots" },
      ],
      heats: [
        makeHeat("S3-H1", { stageIndex: 3, state: "running" }),
      ],
    });

    const graph = buildStageNetworkGraph([s1, s2, s3], race);
    // Because bad-wire (s3 -> s2) is marked invalid, s2 cannot reach s3 and s3 cannot reach s2
    expect(graph.canReach("s3", "s2")).toBe(false);

    // Target s3 has a running heat -> locked against new incoming stage connections
    const startedTarget = graph.validateConnection("s2", "s3");
    expect(startedTarget.valid).toBe(false);
    expect(startedTarget.reason).toContain("already started");

    // Reconnecting `good-wire` (excluding its own ID) allows validating `s1 -> s2` again
    const reconnectGraph = buildStageNetworkGraph([s1, s2, s3], race, "good-wire");
    expect(reconnectGraph.validateConnection("s1", "s2").valid).toBe(true);
  });
});

describe("core/connection_graph — RoundNetworkGraph (Stage Editor Round & Portal DAG)", () => {
  it("enforces portal directionality, Pilots-in starting-round exclusivity, Finals terminal rules, and downstream Stage Out locks", () => {
    const pilotsPortal = makeRound("stage1-pilots-in", { title: "Pilots", bracketLane: "portal" });
    const openQualPortal = makeRound("stage1-open-qual", { title: "Open Qualifier", stageFormat: "open_qualifier" });
    const seedsInPortal = makeRound("stage2-seeds-in", { title: "Stage 1 Seeds", bracketLane: "portal" });
    const stageOutPortal = makeRound("stage1-seeding-out", { title: "Stage Out", bracketLane: "portal" });

    const q1 = makeRound("q1", { title: "Qual R1", stageFormat: "qualifying", bracketLane: "qualifying" });
    const q2 = makeRound("q2", { title: "Qual R2", stageFormat: "qualifying", bracketLane: "qualifying" });
    const w1 = makeRound("w1", { title: "Winners R1", stageFormat: "double_elimination", bracketLane: "winners" });
    const finals = makeRound("gf", { title: "Grand Finals", stageFormat: "double_elimination", bracketLane: "finals" });

    const rounds = [pilotsPortal, openQualPortal, seedsInPortal, stageOutPortal, q1, q2, w1, finals];
    const heatsByRound = new Map<string, RaceHeat[]>([
      ["q1", [makeHeat("Q1-H1", { roundId: "q1" })]],
      ["q2", [makeHeat("Q2-H1", { roundId: "q2" })]],
      ["w1", [makeHeat("W1-H1", { roundId: "w1" })]],
      ["gf", [makeHeat("GF-H1", { roundId: "gf", bracketLane: "finals" })]],
    ]);

    const conns: RoundConnection[] = [
      { id: "c-pilots-q1", fromRoundId: "stage1-pilots-in", toRoundId: "q1", mode: "pilots_in", count: 0 },
      { id: "c-q1-q2", fromRoundId: "q1", toRoundId: "q2", mode: "all_pilots", count: 0 },
    ];

    const race = makeRaceState({
      totalStages: 2,
      rounds,
      connections: conns,
      heats: [
        ...Array.from(heatsByRound.values()).flat(),
        // Downstream Stage 2 has a confirmed heat -> locks Stage 1's Stage Out!
        makeHeat("S2-H1", { stageIndex: 2, state: "confirmed" }),
      ],
    });

    const graph = buildRoundNetworkGraph(race, 1, rounds, heatsByRound, conns);

    // Portal directionality rules
    expect(graph.validateConnection("stage1-seeding-out", "w1").valid).toBe(false);
    expect(graph.validateConnection("stage1-open-qual", "w1").valid).toBe(true);
    expect(graph.validateConnection("gf", "w1").reason).toContain("no outgoing connections");
    expect(graph.validateConnection("q1", "stage1-pilots-in").reason).toContain("does not accept incoming");
    expect(graph.validateConnection("q1", "stage2-seeds-in").reason).toContain("does not accept incoming");
    expect(graph.validateConnection("stage1-pilots-in", "stage1-seeding-out").reason).toContain(
      "into a round before Stage Out"
    );

    // Pilots portal cannot connect to q2 because q2 already has an upstream round feeder (q1 -> q2)
    const pilotsToFedRound = graph.validateConnection("stage1-pilots-in", "q2");
    expect(pilotsToFedRound.valid).toBe(false);
    expect(pilotsToFedRound.reason).toContain("without upstream round feeders");

    // Conversely, an upstream round cannot feed q1 while `Pilots -> q1` is still connected
    const roundToPilotsRound = graph.validateConnection("w1", "q1");
    expect(roundToPilotsRound.valid).toBe(false);
    expect(roundToPilotsRound.reason).toContain("Disconnect “Pilots”");

    // Cycle check: q2 -> q1 blocked once Pilots wire is excluded
    const noPilotsGraph = buildRoundNetworkGraph(race, 1, rounds, heatsByRound, [conns[1]]);
    const loopCheck = noPilotsGraph.validateConnection("q2", "q1");
    expect(loopCheck.valid).toBe(false);
    expect(loopCheck.reason).toContain("creates a loop");

    // Stage Out locked when downstream stage has started heats
    const stageOutLocked = graph.validateConnection("q2", "stage1-seeding-out");
    expect(stageOutLocked.valid).toBe(false);
    expect(stageOutLocked.reason).toContain("Downstream stage has already started");

    // Mode inference checks (including `standings_top` from qualifying -> bracket!)
    expect(graph.inferDefaultMode("stage1-pilots-in", "w1")).toBe("pilots_in");
    expect(graph.inferDefaultMode("stage2-seeds-in", "w1")).toBe("stage_seeds");
    expect(graph.inferDefaultMode("q2", "stage1-seeding-out")).toBe("qual_feed");
    expect(graph.inferDefaultMode("q1", "q2", "right")).toBe("all_pilots");
    expect(graph.inferDefaultMode("q2", "w1", "right")).toBe("standings_top");
    expect(graph.inferDefaultMode("w1", "gf", "right")).toBe("top_per_heat");
    expect(graph.inferDefaultMode("w1", "gf", "bottom")).toBe("bottom_per_heat");
  });

  it("computes recommendedAdvanceCount and prevents Top + Bottom per-heat seat budget overflow", () => {
    const w1 = makeRound("w1", { title: "Round 1" });
    const w2 = makeRound("w2", { title: "Winners R2" });
    const l1 = makeRound("l1", { title: "Losers R1" });
    const rounds = [w1, w2, l1];
    const heatsByRound = new Map<string, RaceHeat[]>([
      ["w1", [makeHeat("W1-H1", { roundId: "w1" }), makeHeat("W1-H2", { roundId: "w1" })]],
      ["w2", [makeHeat("W2-H1", { roundId: "w2" })]],
      ["l1", [makeHeat("L1-H1", { roundId: "l1" })]],
    ]);

    // Case 1: 4 pilots/heat, `Top 3` already advances to w2 -> `Bottom` port has 1 seat left!
    const top3Conn: RoundConnection = {
      id: "c1",
      fromRoundId: "w1",
      toRoundId: "w2",
      fromPort: "right",
      mode: "top_per_heat",
      count: 3,
      customCount: true,
    };
    const race = makeRaceState({
      rounds,
      connections: [top3Conn],
      heats: Array.from(heatsByRound.values()).flat(),
    });
    const g1 = buildRoundNetworkGraph(race, 1, rounds, heatsByRound, [top3Conn]);

    // Default half of 4 is 2, which would overflow 3 + 2 = 5 > 4; recommendedAdvanceCount narrows it to 1!
    expect(g1.recommendedAdvanceCount("w1", "bottom_per_heat")).toBe(1);
    expect(g1.validateConnection("w1", "l1", { fromPort: "bottom" }).valid).toBe(true);
    expect(g1.validateConnection("w1", "l1", { fromPort: "bottom", count: 2 }).valid).toBe(false);

    // Case 2: All 4 heat seats already taken by `Top 4` -> even `Bottom 1` is rejected!
    const top4Conn: RoundConnection = { ...top3Conn, count: 4 };
    const g2 = buildRoundNetworkGraph(race, 1, rounds, heatsByRound, [top4Conn]);
    const res = g2.validateConnection("w1", "l1", { fromPort: "bottom" });
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("uses all 4 heat seats");
  });

  it("enforces Incoming Stage Seeds cap and Finals single-heat capacity (including standings_top & auto-rebalanced feeders)", () => {
    const seedsIn = makeRound("stage2-seeds-in", { stageIndex: 2, title: "Stage 1 Seeds", bracketLane: "portal" });
    const qFast = makeRound("q-fast", { stageIndex: 2, title: "LCQ Qualifier", stageFormat: "qualifying", bracketLane: "qualifying" });
    const semiA = makeRound("semi-a", { stageIndex: 2, title: "Semi A", stageFormat: "double_elimination", bracketLane: "winners" });
    const semiB = makeRound("semi-b", { stageIndex: 2, title: "Semi B", stageFormat: "double_elimination", bracketLane: "losers" });
    const finals = makeRound("gf", { stageIndex: 2, title: "Finals", stageFormat: "double_elimination", bracketLane: "finals" });

    const rounds = [seedsIn, qFast, semiA, semiB, finals];
    const heatsByRound = new Map<string, RaceHeat[]>([
      // LCQ Qualifier has 3 heats, advancing Top 2 overall (`standings_top`, count: 2)
      [
        "q-fast",
        [
          makeHeat("LCQ-1", { stageIndex: 2, roundId: "q-fast" }),
          makeHeat("LCQ-2", { stageIndex: 2, roundId: "q-fast" }),
          makeHeat("LCQ-3", { stageIndex: 2, roundId: "q-fast" }),
        ],
      ],
      ["semi-a", [makeHeat("SA-1", { stageIndex: 2, roundId: "semi-a" }), makeHeat("SA-2", { stageIndex: 2, roundId: "semi-a" })]],
      ["semi-b", [makeHeat("SB-1", { stageIndex: 2, roundId: "semi-b" }), makeHeat("SB-2", { stageIndex: 2, roundId: "semi-b" })]],
      ["gf", [makeHeat("GF-1", { stageIndex: 2, roundId: "gf", bracketLane: "finals" })]],
    ]);

    const roster8 = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => makeEventPilot(s));
    const s1 = makeStage(1, { id: "s1", format: "qualifying" });
    const s2 = makeStage(2, { id: "s2", format: "double_elimination" });

    // Stage 1 -> Stage 2 brings Top 6 seeds. Seeds #1-#6 already assigned to semiA -> 0 seeds left!
    const connsExhaustedSeeds: RoundConnection[] = [
      {
        id: "seed-1-6",
        stageIndex: 2,
        fromRoundId: "stage2-seeds-in",
        toRoundId: "semi-a",
        mode: "stage_seeds",
        count: 6,
        seedStart: 1,
        seedEnd: 6,
      },
    ];
    const race = makeRaceState({
      totalStages: 2,
      activeStageIndex: 2,
      roster: roster8,
      stages: [s1, s2],
      stageConnections: [
        { id: "sc-top6", fromStageId: "s1", toStageId: "s2", fromStageIndex: 1, toStageIndex: 2, mode: "top_n", count: 6 },
      ],
      rounds,
      heats: Array.from(heatsByRound.values()).flat(),
    });

    const seedGraph = buildRoundNetworkGraph(race, 2, rounds, heatsByRound, connsExhaustedSeeds);
    const extraSeedLink = seedGraph.validateConnection("stage2-seeds-in", "semi-b");
    expect(extraSeedLink.valid).toBe(false);
    expect(extraSeedLink.reason).toContain("All 6 incoming stage seeds (#1–#6) are already assigned");

    // Verify `standings_top` (count=2 from 3 heats) uses 2 seats in 4-seat Finals (NOT 3*2=6!),
    // allowing a 2-heat `semi-a` auto-rebalanced feeder (2*1 = 2 seats, total 4 <= 4),
    // while blocking `semi-b` once all 4 Finals seats are spoken for!
    const finalsConns: RoundConnection[] = [
      {
        id: "lcq-to-gf",
        stageIndex: 2,
        fromRoundId: "q-fast",
        toRoundId: "gf",
        mode: "standings_top",
        count: 2,
        customCount: true,
      },
    ];
    const gfGraph1 = buildRoundNetworkGraph(race, 2, rounds, heatsByRound, finalsConns);
    expect(gfGraph1.validateConnection("semi-a", "gf").valid).toBe(true);

    const finalsFullConns: RoundConnection[] = [
      ...finalsConns,
      {
        id: "sa-to-gf",
        stageIndex: 2,
        fromRoundId: "semi-a",
        toRoundId: "gf",
        mode: "top_per_heat",
        count: 1,
        customCount: false,
      },
    ];
    const gfGraphFull = buildRoundNetworkGraph(race, 2, rounds, heatsByRound, finalsFullConns);
    const overflowRes = gfGraphFull.validateConnection("semi-b", "gf");
    expect(overflowRes.valid).toBe(false);
    expect(overflowRes.reason).toContain("Finals has 4 seats max");
  });
});
