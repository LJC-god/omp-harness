/** Shorten `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export function fitJsonPayload(
	payload: { status: string; answer: string; evidence: string[]; artifact?: string; [key: string]: unknown },
	maxBytes: number,
): { text: string; truncated: boolean } {
	const make = (answer: string, evidence: string[], truncated: boolean) =>
		JSON.stringify({ ...payload, answer, evidence, truncated });
	if (Buffer.byteLength(make(payload.answer, payload.evidence, false)) <= maxBytes) {
		return { text: make(payload.answer, payload.evidence, false), truncated: false };
	}
	const fitted = longestFittingAnswer(payload.answer, answer => Buffer.byteLength(make(answer, payload.evidence, true)) <= maxBytes);
	if (fitted !== null) return { text: make(fitted, payload.evidence, true), truncated: true };
	const withoutEvidence = longestFittingAnswer(payload.answer, answer => Buffer.byteLength(make(answer, [], true)) <= maxBytes);
	return { text: make(withoutEvidence ?? "", [], true), truncated: true };
}

function longestFittingAnswer(answer: string, fits: (answer: string) => boolean): string | null {
	if (!fits("")) return null;
	let lo = 0;
	let hi = answer.length;
	let best = "";
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const candidate = answer.slice(0, mid);
		if (fits(candidate)) {
			best = candidate;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best;
}
