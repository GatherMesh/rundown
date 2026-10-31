import type {
  Category,
  ComputedItem,
  Item,
  Person,
  Template,
  PackSettings,
  PlannedPack,
  OutputSide,
} from '../types';
export function computeItems(
  items: Item[],
  categories: Category[],
  people: Person[],
): ComputedItem[] {
  let offset = 0;
  return [...items]
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map((item, i) => {
      const startSec = offset;
      offset += item.durationSec;
      return {
        ...item,
        number: i + 1,
        startSec,
        endSec: offset,
        category: categories.find((c) => c.id === item.categoryId) ?? {
          id: '',
          name: 'Uncategorised',
          bg: '#eef0f3',
          fg: '#4a5160',
          order: 0,
        },
        people: people.filter((p) => item.personIds.includes(p.id)),
      };
    });
}
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function parseDuration(value: string): number {
  if (!/^\d+:[0-5]\d$|^\d+:[0-5]\d:[0-5]\d$/.test(value.trim()))
    throw new Error('Use m:ss or h:mm:ss, for example 5:00.');
  const parts = value.trim().split(':').map(Number);
  const result = parts.reduce((s, n) => s * 60 + n, 0);
  if (!Number.isSafeInteger(result) || result > 86400)
    throw new Error('Duration must be no more than 24 hours.');
  return result;
}
export function time(
  iso: string,
  offset = 0,
  timeZone = 'Australia/Brisbane',
  period = false,
): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(new Date(iso).getTime() + offset * 1000));
  return parts
    .filter((p) => period || p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim();
}
export function filterItems(
  items: ComputedItem[],
  template: Template,
  personId: string | null,
): ComputedItem[] {
  const list = items.filter(
    (i) =>
      template.filter.categoryIds === null || template.filter.categoryIds.includes(i.categoryId),
  );
  const own = (i: ComputedItem) => !!personId && i.personIds.includes(personId);
  if (!personId || template.filter.scope === 'all')
    return list.map((i) => ({ ...i, context: false, isRecipientItem: own(i) }));
  return list.flatMap((item, index) => {
    const assigned = own(item),
      neighbour =
        template.filter.scope === 'recipientPlusNeighbours' &&
        [list[index - 1], list[index + 1]].some((i) => i && own(i));
    return assigned || neighbour
      ? [{ ...item, context: !assigned, isRecipientItem: assigned }]
      : [];
  });
}
export function itemGapLabel(previous: ComputedItem | undefined, next: ComputedItem): string {
  if (!previous || next.number <= previous.number + 1) return '';
  const first = previous.number + 1,
    last = next.number - 1;
  return `${first === last ? `Item ${first}` : `Items ${first}–${last}`} omitted · ${formatDuration(next.startSec - previous.endSec)}`;
}
export function paginate(
  heights: number[],
  available: number,
  onePerPage = false,
  subsequentAvailable = available,
): number[][] {
  if (available <= 0 || subsequentAvailable <= 0)
    throw new Error('Page header leaves no room for items.');
  const pages: number[][] = [];
  let page: number[] = [],
    used = 0;
  heights.forEach((h, i) => {
    const capacity = pages.length === 0 ? available : subsequentAvailable;
    if (page.length && (onePerPage || used + h > capacity)) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(i);
    used += h;
  });
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}
export function fitPagination(
  heights: number[],
  available: number,
  requested?: number,
  onePerPage = false,
  subsequentAvailable = available,
) {
  const at = (s: number) =>
    paginate(
      heights.map((h) => h * s),
      available,
      onePerPage,
      subsequentAvailable,
    );
  if (!requested || at(1).length <= requested) return { pages: at(1), scale: 1, warning: null };
  if (at(0.6).length > requested)
    return {
      pages: at(0.6),
      scale: 0.6,
      warning: `Needs ${at(0.6).length} pages, set to ${requested}`,
    };
  let low = 0.6,
    high = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    if (at(mid).length <= requested) low = mid;
    else high = mid;
  }
  return { pages: at(low), scale: low, warning: null };
}
export function planPack(settings: PackSettings, counts: Record<string, number>): PlannedPack {
  const sides: OutputSide[] = [];
  const duplex = settings.sides !== 'single';
  const capacity = settings.scaling === '4up' ? 4 : settings.scaling === '2up' ? 2 : 1;
  let cells: Extract<OutputSide, { kind: 'pages' }>['cells'] = [];
  let pages = 0;
  const flush = () => {
    if (cells.length) {
      sides.push({ kind: 'pages', cells });
      cells = [];
    }
  };
  const pad = () => {
    flush();
    if (duplex && sides.length % 2) sides.push({ kind: 'blank' });
  };
  if (settings.coverSheet) {
    sides.push({ kind: 'cover' });
    pad();
  }
  for (const ref of settings.templates) {
    const count = counts[ref.templateId];
    if (!Number.isInteger(count) || count < 1)
      throw new Error('Render every template before calculating the pack.');
    if (!Number.isInteger(ref.copies) || ref.copies < 1 || ref.copies > 20)
      throw new Error('Copies must be between 1 and 20.');
    const push = (copy: number, page: number) => {
      cells.push({ templateId: ref.templateId, copy, page });
      pages++;
      if (cells.length === capacity) flush();
    };
    if (settings.collate) {
      for (let c = 1; c <= ref.copies; c++) {
        if (settings.newSheetPerTemplate) pad();
        for (let p = 1; p <= count; p++) push(c, p);
      }
    } else {
      if (settings.newSheetPerTemplate) pad();
      for (let p = 1; p <= count; p++) for (let c = 1; c <= ref.copies; c++) push(c, p);
    }
  }
  flush();
  pad();
  return { sides, sheets: Math.ceil(sides.length / (duplex ? 2 : 1)), pages };
}
export function planCombinedJob(
  packs: { settings: PackSettings; plan: PlannedPack }[],
): OutputSide[] {
  const out: OutputSide[] = [];
  for (const { settings, plan } of packs) {
    if (out.length % 2) out.push({ kind: 'blank' });
    plan.sides.forEach((side, index) => {
      out.push(
        side.kind === 'pages' && settings.sides === 'duplexShort' && index % 2
          ? { ...side, rotate180: true }
          : side,
      );
      if (settings.sides === 'single') out.push({ kind: 'blank' });
    });
    if (out.length % 2) out.push({ kind: 'blank' });
  }
  return out;
}
