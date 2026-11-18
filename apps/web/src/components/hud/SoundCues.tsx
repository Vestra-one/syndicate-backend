import { useEffect, useRef } from 'react'
import { useGameStore } from '@/store/gameStore'
import { playCue } from '@/lib/sound'

/** Plays the table's sound cues off store changes. Renders nothing. */
export function SoundCues() {
  const myTurn = useGameStore((s) => s.yourTurn != null)
  const feedLen = useGameStore((s) => s.feed.length)
  const sealed = useGameStore((s) => s.sealStatus === 'sealed')
  const settlement = useGameStore((s) => s.settlement)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const prevFeed = useRef(feedLen)
  const talkAt = useGameStore((s) => s.talk.at(-1)?.at ?? 0)
  useEffect(() => { if (talkAt) playCue('chip') }, [talkAt])

  useEffect(() => { if (myTurn) playCue('turn') }, [myTurn])
  useEffect(() => { if (sealed) playCue('seal') }, [sealed])
  useEffect(() => {
    if (feedLen > prevFeed.current && !myTurn) playCue('chip')
    prevFeed.current = feedLen
  }, [feedLen, myTurn])
  useEffect(() => {
    if (!settlement || yourSeat == null) return
    const top = settlement.awards.reduce((a, b) => (b.amount > a.amount ? b : a), settlement.awards[0])
    playCue(top && top.seat === yourSeat ? 'win' : 'lose')
  }, [settlement, yourSeat])
  return null
}
