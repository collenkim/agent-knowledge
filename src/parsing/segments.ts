/** 이보다 긴 항목만 나눈다. UTF-16 단위다. */
export const SEGMENT_MAX_CHARS = 1500;

const ATX_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const LEADING_BLANK = /^[ \t]/;
/** `다음 값만 허용한다:`처럼 뒤 블록을 이끄는 줄. 이 줄과 그 대상을 다른 조각으로 떼면 규칙의 조건이나 대상이 사라진다. */
const LEAD_IN = /[:：]\s*$/;
/** `**다음 값만 허용한다:**`처럼 강조 표시가 콜론을 감싼 줄도 이끄는 줄이다. */
const TRAILING_EMPHASIS = /(?:\*{1,3}|_{1,3})\s*$/;

function leadsIn(line: string): boolean {
  return LEAD_IN.test(line.replace(TRAILING_EMPHASIS, ''));
}

export interface SegmentSpan {
  startLine: number;
  endLine: number;
  content: string;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * 긴 항목 본문을 블록 경계에서 나눈다. 경계는 펜스 등의 밖에 있는 ATX 제목 줄 앞과, 빈 줄 다음에 들여쓰지 않은 줄 앞뿐이다.
 * 그래서 표·코드 블록·문단 안의 문장이나 들여쓴 목록 이어짐은 자르지 않는다. 콜론으로 끝나는 이끄는 줄 뒤도 자르지 않는다.
 * 제목 줄 바로 뒤도 자르지 않는다. 제목만 든 조각은 근거가 없는데 제목 일치로 본문보다 앞서기 때문이다.
 * 한 블록이 한도보다 길면 그대로 둔다.
 * 나뉘지 않으면 빈 배열이다. `opaque`는 본문 첫 줄부터의 줄별 표시다.
 */
export function splitSegments(content: string, startLine: number, opaque: readonly boolean[]): SegmentSpan[] {
  if (content.length <= SEGMENT_MAX_CHARS) return [];
  const lines = content.split('\n');
  const starts = [0];
  let lastText = lines[0]!;
  let lastHeading = !opaque[0] && ATX_LINE.test(lines[0]!);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = !opaque[i] && ATX_LINE.test(line);
    const paragraph = isBlank(lines[i - 1]!) && !opaque[i - 1] && !isBlank(line) && !LEADING_BLANK.test(line);
    if ((heading || paragraph) && !lastHeading && !leadsIn(lastText)) starts.push(i);
    if (!isBlank(line)) {
      lastText = line;
      lastHeading = heading;
    }
  }

  const blocks = starts.map((from, index) => {
    const to = starts[index + 1] ?? lines.length;
    return { from, to, size: lines.slice(from, to).join('\n').length };
  });
  // 한도까지 꽉 채우면 마지막 조각이 한 문장만 남기도 한다. 남은 길이를 필요한 조각 수로 나눈 목표에 가깝게 고르게 나눈다
  const groups: { from: number; to: number }[] = [];
  for (let i = 0; i < blocks.length; ) {
    const remaining = blocks.slice(i).reduce((sum, block) => sum + block.size + 1, -1);
    const target = remaining / Math.ceil(remaining / SEGMENT_MAX_CHARS);
    let chars = blocks[i]!.size;
    let j = i + 1;
    for (; j < blocks.length; j++) {
      const next = chars + 1 + blocks[j]!.size;
      if (next > SEGMENT_MAX_CHARS || (next > target && next - target > target - chars)) break;
      chars = next;
    }
    groups.push({ from: blocks[i]!.from, to: blocks[j - 1]!.to });
    i = j;
  }
  if (groups.length <= 1) return [];

  return groups.map(({ from, to }) => {
    let last = to - 1;
    while (last > from && isBlank(lines[last]!)) last--;
    return { startLine: startLine + from, endLine: startLine + last, content: lines.slice(from, last + 1).join('\n') };
  });
}
