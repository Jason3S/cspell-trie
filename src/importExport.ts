import { TrieNode, FLAG_WORD, ChildMap } from './trie';
import { TrieRefNode, RefMap } from './trieRef';
import { Sequence, genSequence } from 'gensequence';
import * as Rx from 'rxjs/Rx';

interface LeafResult { n: TrieRefNode; p?: TrieRefNode; k: string; }

function leaves(node: TrieNode): Sequence<LeafResult> {
    function *walk(node: TrieNode, k: string, p?: TrieNode): IterableIterator<LeafResult> {
        if (!node.c) {
            yield { n: node, p, k};
        } else {
            const children = [...node.c];
            for (const n of children) {
                yield* walk(n[1], n[0], node);
            }
        }
    }

    return genSequence(walk(node, ''));
}

function flattenToReferences(node: TrieNode): Sequence<TrieNode> {

    function * walk() {
        let iterations = 100;
        let processed = 0;
        let index = 0;

        function hash(node: TrieRefNode): string {
            const flags = node.f ? '*' : '';
            const refs = node.r ? '{' + [...node.r].sort((a, b) => a[0] < b[0] ? -1 : 1).map(a => a.join(':')).join(',') + '}' : '';
            return flags + refs;
        }

        do {
            processed = 0;
            let hashMap = new Map<string, number>();
            for (const leaf of leaves(node)) {
                const h = hash(leaf.n);
                let m = hashMap.get(h);
                if (m === undefined) {
                    // first time, add it to hash
                    yield leaf.n;
                    m = index;
                    hashMap.set(h, m);
                    index += 1;
                }

                // Fix up the parent
                if (leaf.p && leaf.p.c) {
                    leaf.p.r = leaf.p.r || new RefMap();
                    leaf.p.r.set(leaf.k, m);
                    leaf.p.c.delete(leaf.k);
                    if (!leaf.p.c.size) {
                        delete leaf.p.c;
                    }
                }
                processed += 1;
            }
            iterations -= 1;
        } while (processed && iterations && node.c);

        yield node;
    }

    return genSequence(walk());
}

const regExpEscapeChars = /([\[\]\\,:{}*])/;
const regExTrailingComma = /,(\}|\n)/g;

function escapeChar(char: string): string {
    return char.replace(regExpEscapeChars, '\\$1');
}

export function trieToExportString(node: TrieNode, base = 16): Sequence<string> {
    function* walk(node: TrieRefNode): IterableIterator<string> {
        if (node.f) {
            yield '*';
        }
        if (node.c) {
            yield '[';
            for (const n of node.c) {
                yield escapeChar(n[0]) + '[';
                yield* walk(n[1]);
                yield ']';
            }
            yield ']';
        }
        if (node.r) {
            const refs = [...node.r].sort((a, b) => a[0] < b[0] ? -1 : 1);
            for (const n of refs) {
                const [c, r] = n;
                const ref = r ? r.toString(base) : '';
                yield escapeChar(c) + ref + ',';
            }
        }
    }

    return genSequence(walk(node));
}


function generateHeader(base: number): Sequence<string> {
    const header = [
        'TrieXv1',
        'base=' + base,
    ];
    return genSequence(header)
        .map(a => a + '\n');
}


export function exportTrie(node: TrieNode, base = 16): Sequence<string> {
    const rows = flattenToReferences(node)
        .map(node => {
            const row = [
                ...trieToExportString(node, base),
                '\n',
            ]
            .join('').replace(regExTrailingComma, '$1');
            return row;
        });

    return generateHeader(base)
        .concat(rows);
}


export function importTrieRx(lines: Rx.Observable<string>): Rx.Observable<TrieNode> {
    const headerLines = new Rx.Subject<string>();

    let radix = 16;

    headerLines
        .take(2)
        .map(a => a.trim())
        .toArray()
        .subscribe(headerRows => {
            const header = headerRows.join('\n');
            const headerReg = /^TrieXv1\nbase=(\d+)$/;
            if (!headerReg.test(header)) throw new Error('Unknown file format');
            radix = Number.parseInt(header.replace(headerReg, '$1'), 10);
        });

    interface ReduceResults {
        lines: number;
        nodes: TrieNode[];
        root: TrieNode;
    }

    const regNotEscapedCommas = /(^|[^\\]),/g;
    const regUnescapeCommas = /__COMMA__/g;
    const regUnescape = /[\\](.)/g;

    function splitLine(line: string) {
        const pattern = '$1__COMMA__';
        return line
            .replace(regNotEscapedCommas, pattern)
            .split(regUnescapeCommas)
            .map(a => a.replace(regUnescape, '$1'));
    }

    function decodeLine(line: string, nodes: TrieNode[]): TrieNode {
        const isWord = line[0] === '*';
        line = isWord ? line.slice(1) : line;
        const flags = isWord ? { f: FLAG_WORD } : {};
        const children: [string, TrieNode][] = splitLine(line)
            .filter(a => !!a)
            .map<[string, number]>(a => [
                a[0],
                Number.parseInt((a.slice(1) || '0'), radix),
            ])
            .map<[string, TrieNode]>(([k, i]) => [k, nodes[i]]);
        const cNode = children.length ? { c: new ChildMap(children) } : {};
        return {...cNode, ...flags};
    }

    const r = lines
        .do<string>(headerLines)
        .map(a => a.trim())
        .skipWhile(line => line !== '*')
        .filter(a => !!a)
        .reduce<string, ReduceResults>((acc, line) => {
            const { lines, nodes } = acc;
            const root = decodeLine(line, nodes);
            nodes[lines] = root;
            return { lines: lines + 1, root, nodes };
        }, { lines: 0, nodes: [], root: {} })
        .do(r => {
            // console.log(r.lines);
        })
        .map(r => r.root)
        ;

    return r;
}
