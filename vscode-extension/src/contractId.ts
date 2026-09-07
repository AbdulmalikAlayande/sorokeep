/**
 * Detect Stellar contract IDs (56-char, uppercase, 'C'-prefixed) inside source
 * text. Mirrors sorokeep's own contract-ID shape (see `validateContractId` in
 * src/utils/formatting.ts). Detection is deliberately conservative: it only
 * matches a full 56-char C-prefixed string so we never emit false positive
 * CodeLens for account keys, truncated IDs, or split literals.
 */
export interface ContractIdMatch {
    contractId: string;
    /** Character offset of the start of the match in the document text. */
    start: number;
    /** Character offset just past the end of the match. */
    end: number;
}

// Reset-able global is used so repeated calls don't carry `lastIndex` state.
// Lookarounds (`(?<![A-Z0-9])` / `(?![A-Z0-9])`) require the 56-char run to
// be a whole token, so a C[A-Z0-9]{56,...} prefix inside a longer base32
// string is NOT treated as a contract ID (avoids false positives).
let RE: RegExp | null = null;

function contractIdRegex(): RegExp {
    if (!RE) RE = /(?<![A-Z0-9])C[A-Z0-9]{55}(?![A-Z0-9])/g;
    return RE;
}

export function extractContractIds(text: string): ContractIdMatch[] {
    const matches: ContractIdMatch[] = [];
    const re = contractIdRegex();
    re.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        matches.push({
            contractId: m[0],
            start: m.index,
            end: m.index + m[0].length,
        });
        // Avoid infinite loops on zero-width matches (defensive; the pattern is not zero-width).
        if (m.index === re.lastIndex) re.lastIndex += 1;
    }

    re.lastIndex = 0;
    return matches;
}