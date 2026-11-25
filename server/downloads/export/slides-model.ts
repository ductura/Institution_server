// Pure projection of a slides document (docs/contracts/slides-v1.md) into what
// a .pptx prints: per slide a title, the blocks of each slot and the speaker
// notes. Slide numbers are derived from the order, never stored. No I/O.
import {
  LAYOUT_SLOTS,
  type SlideBlock,
  type SlideLayout,
  type SlideSlot,
  type SlidesDocument,
} from "../../domain/index.ts";

/** Words the .pptx prints; the caller takes them from the message catalogue. */
export type SlidesExportLabels = {
  /** Name of a slide without a title heading: "<slide> <number>". */
  readonly slide: string;
  /** Title of the presentation when no slide has a title. */
  readonly presentation: string;
};

export type SlidesExportBlock = SlideBlock;

export type SlidesExportRegion = {
  readonly slot: SlideSlot;
  readonly blocks: readonly SlidesExportBlock[];
};

export type SlidesExportSlide = {
  /** 1-based position. */
  readonly number: number;
  readonly id: string;
  readonly layout: SlideLayout;
  /** Text of the title block, or "<slide> <number>". */
  readonly title: string;
  /** One region per slot of the layout, in the order of `LAYOUT_SLOTS`; empty slots too. */
  readonly regions: readonly SlidesExportRegion[];
  readonly notes?: string;
};

export type SlidesExportModel = {
  /** Title of the first slide that has one, or the label for a presentation. */
  readonly title: string;
  readonly slides: readonly SlidesExportSlide[];
};

export function buildSlidesExportModel(
  doc: SlidesDocument,
  labels: SlidesExportLabels,
): SlidesExportModel {
  let title = "";
  const slides = doc.slides.map((slide, index): SlidesExportSlide => {
    const number = index + 1;
    const regions = LAYOUT_SLOTS[slide.layout].map((slot): SlidesExportRegion => ({
      slot,
      blocks: slide.blocks.filter((block) => block.slot === slot),
    }));
    const heading = slide.blocks.find((block) => block.slot === "title");
    const own = heading?.type === "heading" ? heading.text : "";
    if (title === "" && own !== "") title = own;
    return {
      number,
      id: slide.id,
      layout: slide.layout,
      title: own !== "" ? own : `${labels.slide} ${number}`,
      regions,
      ...(slide.notes !== undefined ? { notes: slide.notes } : {}),
    };
  });
  return { title: title !== "" ? title : labels.presentation, slides };
}
