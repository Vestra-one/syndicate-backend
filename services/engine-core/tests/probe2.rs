use syndicate_engine_core::{Action, Engine, Phase};
use syndicate_shared::PlayerId;

fn pid(n: u16) -> PlayerId {
    PlayerId(n)
}
fn total_chips(e: &Engine) -> u64 {
    e.seats.iter().map(|s| s.stack + s.total_contribution).sum()
}

// Short all-in that bumps current_bet between two already-acted players.
// p0 bet, p1 called, p2 short all-in above bet but not a full raise.
// Does p0/p1 get to act again, and does street eventually close correctly?
#[test]
fn probe_short_allin_partial_bump() {
    // stacks: p0=100,p1=100,p2=14 ; bb=2 sb=1 button=0
    let mut e = Engine::new(
        vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 14, 2)],
        0,
        1,
        2,
        3,
    );
    let before = total_chips(&e);
    // p0 raises to 10 (last_raise=8). p1 calls 10. p2(committed2,stack12->max14) all-in to 14.
    e.apply(0, Action::RaiseTo(10)).unwrap();
    e.apply(1, Action::Call).unwrap();
    // raise_increment = 14-10 = 4 < last_raise 8 => NOT full. current_bet bumped to 14, no reopen.
    e.apply(2, Action::AllIn).unwrap();
    println!(
        "after p2 short allin: cb={} to_act={:?} phase={:?} has_acted={:?}",
        e.current_bet, e.to_act, e.phase, e.has_acted
    );
    println!(
        "committed={:?}",
        e.seats
            .iter()
            .map(|s| s.street_committed)
            .collect::<Vec<_>>()
    );
    // p0 faces 14, committed 10. Must be allowed to act (call 4 more or fold). NOT closed.
    assert_eq!(e.phase, Phase::Live);
    // p0 calls the extra 4
    let actor = e.to_act.unwrap();
    println!("actor={}", actor);
    e.apply(actor, Action::Call).unwrap();
    println!(
        "after call: cb={} to_act={:?} phase={:?}",
        e.current_bet, e.to_act, e.phase
    );
    if e.phase == Phase::Live {
        let a2 = e.to_act.unwrap();
        e.apply(a2, Action::Call).unwrap();
        println!("after 2nd call: round={} phase={:?}", e.round, e.phase);
    }
    assert_eq!(total_chips(&e), before);
}

// Probe: heads-up blind/button correctness and who acts.
#[test]
fn probe_heads_up() {
    let mut e = Engine::new(vec![(pid(0), 100, 0), (pid(1), 100, 1)], 0, 1, 2, 2);
    // n==2: sb=button=p0, bb=p1. to_act = contender_at_or_after(sb=0) = p0.
    println!(
        "HU preflop to_act={:?} committed={:?}",
        e.to_act,
        e.seats
            .iter()
            .map(|s| s.street_committed)
            .collect::<Vec<_>>()
    );
    // p0 (sb/button) acts first preflop - correct for HU.
    assert_eq!(e.to_act, Some(0));
    e.apply(0, Action::Call).unwrap(); // p0 completes to 2
    e.apply(1, Action::Check).unwrap(); // bb checks -> street 2
                                        // postflop in HU: button acts LAST. first to act = contender_at_or_after(button+1=1) = p1.
    println!("HU flop to_act={:?} round={}", e.to_act, e.round);
}

// Probe: a folded/all-in player can still post-act? Try acting out of turn after folding.
#[test]
fn probe_act_after_fold() {
    let mut e = Engine::new(
        vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 100, 2)],
        0,
        1,
        2,
        3,
    );
    e.apply(0, Action::Fold).unwrap();
    // p0 tries to act again
    let r = e.apply(0, Action::Call);
    println!("act after fold = {:?}", r);
    // p0 tries to raise out of turn
    let r2 = e.apply(0, Action::RaiseTo(50));
    println!("raise out of turn after fold = {:?}", r2);
}

// Probe: settlement contribution = total across streets. Verify to_player_states maps total_contribution.
#[test]
fn probe_contribution_mapping() {
    let mut e = Engine::new(
        vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 100, 2)],
        0,
        1,
        2,
        3,
    );
    e.apply(0, Action::Call).unwrap();
    e.apply(1, Action::Call).unwrap();
    e.apply(2, Action::Check).unwrap();
    let ps = e.to_player_states(|_| Some(100));
    for p in &ps {
        println!(
            "id={} contribution={} folded={}",
            p.id.0, p.contribution, p.folded
        );
    }
}
