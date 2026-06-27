import { TableCanvas } from '@/components/table/TableCanvas'
import { ComingSoon } from '@/components/coming-soon/ComingSoon'

/**
 * Coming-soon mode: the 3D table renders as the showpiece behind the launch
 * overlay. The live game (Dashboard / Hud, store-driven) is preserved in the
 * codebase — restore it here when the table opens.
 *
 * The room around the table (chandelier, chairs, panelling, ETH crest) is the
 * reference photograph, painted as the 3D scene's background; the live table
 * sits centred over the image's own table, hiding it. See tableScene.ts.
 */
export default function App() {
  return (
    <>
      <TableCanvas pot={2400} />
      <div className="scene-vignette" />
      <ComingSoon />
    </>
  )
}
