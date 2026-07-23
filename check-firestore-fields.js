#!/usr/bin/env node
/**
 * check-firestore-fields.js
 *
 * 目的：
 *   firestore.rules 内の各コレクションの hasOnly([...]) と、
 *   index.html 内のクライアント側定数 FIRESTORE_CLIENT_FIELDS が
 *   ズレていないかを機械的にチェックする。
 *
 *   過去に「クライアントが書き込んでいる/期待しているフィールドと、
 *   ルール側の許可リストが食い違う」バグが起きたため、
 *   同じミスを繰り返さないよう、デプロイ前にこのスクリプトを実行する運用とする。
 *
 * 使い方：
 *   node scripts/check-firestore-fields.js
 *   （終了コード 0 = 一致 / 1 = 不一致または解析失敗）
 *
 * 制限事項：
 *   これは正規のCEL/Rulesパーサではなく、素朴な行ベースの簡易パーサです。
 *   firestore.rules の書式が大きく変わった場合は追従できない可能性があります。
 *   その場合はこのスクリプト自体の更新が必要です。
 */

const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const HTML_PATH = path.join(__dirname, '..', 'index.html');

function fail(msg) {
  console.error('✗ ' + msg);
  process.exitCode = 1;
}

function parseRulesFieldAllowlists(rulesSrc) {
  const lines = rulesSrc.split('\n');
  const stack = []; // { depth, segment }
  let braceDepth = 0;
  const collected = {}; // fullPath -> Set(fields)

  for (const line of lines) {
    // このタイミングでの hasOnly(...) は「現在開いている最内の match ブロック」に属するとみなす
    const hasOnlyMatches = [...line.matchAll(/hasOnly\(\[([^\]]*)\]\)/g)];
    if (hasOnlyMatches.length && stack.length) {
      const fullPath = stack.map(function (s) { return s.segment; }).join('')
        .replace(/^\//, '')
        .replace(/^databases\/\{database\}\/documents\//, '');
      hasOnlyMatches.forEach(function (m) {
        const fields = m[1]
          .split(',')
          .map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); })
          .filter(Boolean);
        if (!collected[fullPath]) collected[fullPath] = new Set();
        fields.forEach(function (f) { collected[fullPath].add(f); });
      });
    }

    const matchOpen = line.match(/\bmatch\s+(\/\S+)\s*\{\s*$/);
    if (matchOpen) {
      stack.push({ depth: braceDepth + 1, segment: matchOpen[1] });
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      continue;
    }

    braceDepth += (line.match(/\{/g) || []).length;
    braceDepth -= (line.match(/\}/g) || []).length;

    while (stack.length && braceDepth < stack[stack.length - 1].depth) {
      stack.pop();
    }
  }

  return collected;
}

function parseClientFieldAllowlist(htmlSrc) {
  const marker = 'const FIRESTORE_CLIENT_FIELDS = {';
  const start = htmlSrc.indexOf(marker);
  if (start === -1) {
    throw new Error('index.html 内に FIRESTORE_CLIENT_FIELDS が見つかりませんでした');
  }
  const braceStart = start + marker.length - 1; // '{' の位置
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < htmlSrc.length; i++) {
    if (htmlSrc[i] === '{') depth++;
    else if (htmlSrc[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) {
    throw new Error('FIRESTORE_CLIENT_FIELDS の閉じ括弧が見つかりませんでした');
  }
  const objLiteral = htmlSrc.slice(braceStart, end + 1);
  // eslint-disable-next-line no-new-func
  const obj = Function('"use strict"; return (' + objLiteral + ');')();
  const result = {};
  Object.keys(obj).forEach(function (key) {
    result[key] = new Set(obj[key]);
  });
  return result;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function main() {
  let rulesSrc, htmlSrc;
  try {
    rulesSrc = fs.readFileSync(RULES_PATH, 'utf8');
    htmlSrc = fs.readFileSync(HTML_PATH, 'utf8');
  } catch (e) {
    fail('ファイルの読み込みに失敗しました: ' + e.message);
    process.exit(1);
  }

  let rulesFields, clientFields;
  try {
    rulesFields = parseRulesFieldAllowlists(rulesSrc);
    clientFields = parseClientFieldAllowlist(htmlSrc);
  } catch (e) {
    fail('解析に失敗しました: ' + e.message);
    process.exit(1);
  }

  let ok = true;
  const allPaths = new Set([].concat(Object.keys(rulesFields), Object.keys(clientFields)));

  allPaths.forEach(function (p) {
    const inClient = clientFields[p];
    const inRules = rulesFields[p];

    if (!inClient) {
      // ルール側にはあるがクライアント定義に無いパス（例：rounds/{roundId} は
      // クライアントから一切書き込まないので対象外でOK）。ここでは無視する。
      return;
    }
    if (!inRules) {
      fail(p + ' : firestore.rules 側に対応する hasOnly([...]) が見つかりませんでした');
      ok = false;
      return;
    }
    if (!setsEqual(inClient, inRules)) {
      ok = false;
      fail(
        p + ' のフィールドが一致しません\n' +
        '    client : ' + Array.from(inClient).sort().join(', ') + '\n' +
        '    rules  : ' + Array.from(inRules).sort().join(', ')
      );
    }
  });

  if (ok) {
    console.log('✓ firestore.rules と index.html の FIRESTORE_CLIENT_FIELDS は一致しています');
    process.exit(0);
  } else {
    console.error('\n上記のズレを firestore.rules または index.html 側で修正してください。');
    process.exit(1);
  }
}

main();
