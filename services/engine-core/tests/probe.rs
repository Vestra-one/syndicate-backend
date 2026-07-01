use syndicate_engine_core::{Action, Engine, EngineError, Phase};
use syndicate_shared::PlayerId;

fn pid(n: u16) -> PlayerId { PlayerId(n) }

fn total_chips(e: &Engine) -> u64 {
    e.seats.iter().map(|s| s.stack + s.total_contribution).sum()
}

// Probe 1: short all-in raise — does it reopen action illegitimately or let
// already-acted players act again? Classic poker incomplete-raise rule.
#[test]
fn probe_short_allin_reopen() {
    // 3 handed, stacks: p0=100, p1=100, p2=5 ; sb=1 bb=2 button=0
    let mut e = Engine::new(vec![(pid(0),100,0),(pid(1),100,1),(pid(2),5,2)], 0, 1, 2, 3);
    // blinds: p1=1(sb), p2=2(bb). to_act = p0.
    let before = total_chips(&e);
    e.apply(0, Action::RaiseTo(10)).unwrap(); // p0 raises to 10, last_raise=8
    // p1 to act. p1 raises to 30 (full). last_raise=20
    e.apply(1, Action::RaiseTo(30)).unwrap();
    // p2 has only 5 stack, committed 2 -> max = 7. all-in to 7 (short, < current_bet 30)
    let r = e.apply(2, Action::AllIn);
    println!("p2 allin result={:?} current_bet={} to_act={:?} last_raise={}", r, e.current_bet, e.to_act, e.last_raise_size);
    // Now whose turn? Should be p0 (faces p1's 30). p0 already acted but p1 reopened.
    println!("seats after: {:?}", e.seats.iter().map(|s|(s.street_committed,s.stack,s.all_in,s.folded)).collect::<Vec<_>>());
    assert_eq!(total_chips(&e), before, "chip conservation broken");
}

// Probe 2: can a non-full all-in re-grant action to players who already called?
#[test]
fn probe_allin_below_bet_no_reopen() {
    let mut e = Engine::new(vec![(pid(0),100,0),(pid(1),100,1),(pid(2),3,2)], 0, 1, 2, 3);
    // p0 raises to 8. last_raise=6
    e.apply(0, Action::RaiseTo(8)).unwrap();
    // p1 calls 8.
    e.apply(1, Action::Call).unwrap();
    // p2 (bb, committed 2, stack 1) all-in to 3 (< 8, short). Should NOT reopen.
    e.apply(2, Action::AllIn).unwrap();
    println!("after p2 short allin: to_act={:?} phase={:?} current_bet={}", e.to_act, e.phase, e.current_bet);
    // If reopened, p0 would be asked to act again though nothing legitimately raised.
}

// Probe 3: conservation through a full multi-street hand with an all-in side pot.
#[test]
fn probe_sidepot_conservation() {
    let mut e = Engine::new(vec![(pid(0),100,0),(pid(1),50,1),(pid(2),20,2)], 0, 1, 2, 3);
    let before = total_chips(&e);
    // drive an all-in war
    let _ = e.apply(0, Action::RaiseTo(100)); // p0 all-in 100
    println!("p0 r: to_act={:?}", e.to_act);
    let _ = e.apply(1, Action::AllIn); // p1 all-in 50
    println!("p1 r: to_act={:?}", e.to_act);
    let _ = e.apply(2, Action::AllIn); // p2 all-in 20
    println!("phase={:?} to_act={:?}", e.phase, e.to_act);
    let contribs: Vec<u64> = e.seats.iter().map(|s| s.total_contribution).collect();
    println!("contribs={:?}", contribs);
    assert_eq!(total_chips(&e), before, "conservation broken in all-in war");
}

// Probe 4: BetTo with amount 0 / below big blind handling.
#[test]
fn probe_zero_bet() {
    let mut e = Engine::new(vec![(pid(0),100,0),(pid(1),100,1),(pid(2),100,2)], 0, 1, 2, 3);
    e.apply(0, Action::Call).unwrap(); // p0 calls to 2
    e.apply(1, Action::Call).unwrap(); // p1 (sb) calls to 2
    e.apply(2, Action::Check).unwrap(); // bb checks -> street 2
    println!("street2 round={} to_act={:?} current_bet={}", e.round, e.to_act, e.current_bet);
    let actor = e.to_act.unwrap();
    // BetTo(0) on fresh street
    let r0 = e.apply(actor, Action::BetTo(0));
    println!("BetTo(0) = {:?}", r0);
    let r1 = e.apply(actor, Action::BetTo(1));
    println!("BetTo(1) [below bb=2] = {:?}", r1);
}

// Probe 5: can you raise to your full stack as a "min raise" that is actually below min but allowed as all-in,
// and does current_bet move so others must over-call?
#[test]
fn probe_raise_to_equal_currentbet() {
    let mut e = Engine::new(vec![(pid(0),100,0),(pid(1),100,1),(pid(2),100,2)], 0, 1, 2, 3);
    // current_bet=2. p0 RaiseTo(2) -> total<=cb rejected.
    let r = e.apply(0, Action::RaiseTo(2));
    assert_eq!(r, Err(EngineError::RaiseTooSmall));
}
