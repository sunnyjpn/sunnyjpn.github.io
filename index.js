const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// ---- ランキング荒らし対策のパラメータ ----
// 注：startRound / submitScore は enforceAppCheck: true により、
//     Firebase App Check の有効なトークンを伴わないリクエストは
//     関数の中身が実行される前にFirebase側で拒否される
//     （Bot・スクリプトからの直接呼び出し・外部アプリからの流用を防止）。
const MIN_MS = 50;                 // 許容する反応時間の下限
const MAX_MS = 1000;               // 許容する反応時間の上限
const MIN_WAIT_FLOOR_MS = 1500;    // 実際の待機は2000〜5000msあるため、安全マージンを引いた最低ライン
const ROUND_EXPIRY_MS = 60 * 1000; // startRound発行から60秒以内に送信すること（放置トークンの悪用防止）
const SUBMIT_COOLDOWN_MS = 5000;   // 1ユーザーが連続でスコアを送信できる最短間隔（5秒に1回で十分）
const RECENT_RAW_MAX = 8;          // 同一値の連続検知に使う直近の生スコア保持数
const REPEAT_FLAG_THRESHOLD = 6;   // 直近8件中6件以上が同一(丸め一致)ならBot疑いとしてフラグ

// ---- フレンド機能のパラメータ ----
const FRIEND_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0/O, 1/I)は除外
const FRIEND_CODE_LENGTH = 6;
const FRIEND_CODE_MAX_ATTEMPTS = 10;      // 衝突時の再抽選回数上限
const FRIEND_REQUEST_COOLDOWN_MS = 3000;  // 連続送信の最短間隔
const MAX_PENDING_SENT_REQUESTS = 30;     // 未承認のまま送信できるリクエスト数の上限（荒らし防止）

function generateFriendCode() {
  let code = '';
  for (let i = 0; i < FRIEND_CODE_LENGTH; i++) {
    code += FRIEND_CODE_CHARS.charAt(Math.floor(Math.random() * FRIEND_CODE_CHARS.length));
  }
  return 'SUN-' + code;
}

/**
 * 自分のフレンドIDを取得する。未発行なら、他と衝突しないIDをサーバー側で新規発行する。
 * friendCode は Admin SDK からのみ書き込める設計（firestore.rules参照）なので、
 * この関数がその唯一の発行経路になる。
 */
exports.ensureFriendCode = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const userRef = db.collection('users').doc(uid);

  const existing = await userRef.get();
  if (existing.exists && typeof existing.data().friendCode === 'string' && existing.data().friendCode) {
    return { friendCode: existing.data().friendCode };
  }

  for (let attempt = 0; attempt < FRIEND_CODE_MAX_ATTEMPTS; attempt++) {
    const code = generateFriendCode();
    const codeRef = db.collection('friendCodes').doc(code);

    try {
      const assigned = await db.runTransaction(async (tx) => {
        const [codeSnap, userSnap] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);

        // 直前の呼び出しと競合して、その間に発行済みになっていた場合はそれを採用
        if (userSnap.exists && typeof userSnap.data().friendCode === 'string' && userSnap.data().friendCode) {
          return userSnap.data().friendCode;
        }
        if (codeSnap.exists) {
          return null; // 衝突。呼び出し元でリトライする。
        }

        tx.set(codeRef, { uid: uid, createdAt: FieldValue.serverTimestamp() });
        tx.set(userRef, {
          friendCode: code,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: userSnap.exists ? (userSnap.data().createdAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp()
        }, { merge: true });

        return code;
      });

      if (assigned) return { friendCode: assigned };
    } catch (e) {
      // 稀な同時書き込み衝突。次のループでリトライする。
    }
  }

  throw new HttpsError('resource-exhausted', 'フレンドIDの発行に失敗しました。もう一度お試しください');
});

/**
 * ラウンド開始トークンの発行。
 * クライアントは「待機画面（赤→緑への遷移）」を表示する直前にこれを呼び、
 * 返ってきた roundId を保持しておく。
 * armedAt はサーバー時刻（Admin SDKのserverTimestamp）で記録するため、
 * クライアント側で改ざんすることはできない。
 */
exports.startRound = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const roundRef = db.collection('users').doc(uid).collection('rounds').doc();
  await roundRef.set({
    armedAt: FieldValue.serverTimestamp(),
    used: false
  });
  return { roundId: roundRef.id };
});

/**
 * スコア送信。ここで「本当にプレイしたか」「異常値でないか」をまとめて検証する。
 *
 * 「本当にプレイしたか」の核心チェック：
 *   startRound から submitScore までのサーバー側の経過時間が、
 *   申告された反応時間 ms だけでは説明できないほど短い場合は拒否する。
 *   実際のゲームは必ず 2000〜5000ms のランダムな待機を挟むため、
 *   正規のプレイであれば経過時間は常に ms + 1500ms 以上になるはずである。
 *   startRound の呼び出し自体を偽装・省略することもできないため、
 *   「for文で submitScore を1万回呼ぶ」ような攻撃はこの時点で全て拒否される。
 */
exports.submitScore = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const data = request.data || {};
  const roundId = data.roundId;
  const ms = data.ms;

  if (typeof roundId !== 'string' || !roundId) {
    throw new HttpsError('invalid-argument', 'roundId が不正です');
  }
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
    throw new HttpsError('invalid-argument', 'スコアが許容範囲外です');
  }

  const userRef = db.collection('users').doc(uid);
  const roundRef = userRef.collection('rounds').doc(roundId);
  // クライアント側が小数点第2位まで送ってくるため、サーバー側も同じ精度で保持する
  const roundedMs = Math.round(ms * 100) / 100;

  const result = await db.runTransaction(async (tx) => {
    const [roundSnap, userSnap] = await Promise.all([tx.get(roundRef), tx.get(userRef)]);

    if (!roundSnap.exists) {
      throw new HttpsError('failed-precondition', '無効なラウンドです');
    }
    const round = roundSnap.data();
    if (round.used) {
      throw new HttpsError('failed-precondition', 'このラウンドは既に使用済みです');
    }
    if (!round.armedAt) {
      throw new HttpsError('failed-precondition', 'ラウンド情報が不正です');
    }

    const now = Timestamp.now();
    const elapsed = now.toMillis() - round.armedAt.toMillis();

    if (elapsed > ROUND_EXPIRY_MS) {
      throw new HttpsError('failed-precondition', 'ラウンドの有効期限が切れています');
    }
    if (elapsed < roundedMs + MIN_WAIT_FLOOR_MS) {
      // 実際に待機・反応する過程を経ずに結果だけ送信してきたケース
      throw new HttpsError('failed-precondition', 'プレイの記録が確認できませんでした');
    }

    const user = userSnap.exists ? userSnap.data() : {};

    // 連投防止（5秒に1回まで）。updatedAt はサーバー時刻なので回避不可。
    if (user.updatedAt) {
      const sinceLast = now.toMillis() - user.updatedAt.toMillis();
      if (sinceLast < SUBMIT_COOLDOWN_MS) {
        throw new HttpsError('resource-exhausted', '送信間隔が短すぎます。しばらく待ってから再度お試しください');
      }
    }

    // --- 異常検知：同一値の連続送信（Botらしいパターン）をフラグ付け ---
    const recentRaw = Array.isArray(user.recentRawMs) ? user.recentRawMs.slice(-(RECENT_RAW_MAX - 1)) : [];
    recentRaw.push(roundedMs);
    let suspicious = !!user.suspicious;
    if (recentRaw.length >= REPEAT_FLAG_THRESHOLD) {
      const counts = {};
      let maxCount = 0;
      recentRaw.forEach(function (v) {
        counts[v] = (counts[v] || 0) + 1;
        if (counts[v] > maxCount) maxCount = counts[v];
      });
      if (maxCount >= REPEAT_FLAG_THRESHOLD) suspicious = true;
    }

    const prevBest = typeof user.bestScore === 'number' ? user.bestScore : null;
    const bestScore = prevBest === null ? roundedMs : Math.min(prevBest, roundedMs);
    const isNewBest = prevBest === null || roundedMs < prevBest;
    const attemptCount = (typeof user.attemptCount === 'number' ? user.attemptCount : 0) + 1;
    const totalTimeSum = (typeof user.totalTimeSum === 'number' ? user.totalTimeSum : 0) + roundedMs;
    const recentHistory = Array.isArray(user.recentHistory) ? user.recentHistory.slice(-4) : [];
    recentHistory.push(roundedMs);

    const payload = {
      bestScore: bestScore,
      attemptCount: attemptCount,
      totalTimeSum: totalTimeSum,
      recentHistory: recentHistory,
      recentRawMs: recentRaw,
      suspicious: suspicious,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (!userSnap.exists) payload.createdAt = FieldValue.serverTimestamp();

    tx.set(userRef, payload, { merge: true });
    tx.update(roundRef, { used: true });

    return { bestScore: bestScore, attemptCount: attemptCount, totalTimeSum: totalTimeSum, isNewBest: isNewBest, suspicious: suspicious };
  });

  return Object.assign({ ok: true }, result);
});

/**
 * フレンドリクエストの送信。
 * 相手には friendRequests/{自分のuid} を、自分には sentFriendRequests/{相手のuid} を作成する。
 * どちらもクライアントSDKからは直接書き込めない設計（firestore.rules参照）ため、
 * この関数を経由することで、なりすまし送信・大量送信を防止する。
 */
exports.sendFriendRequest = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const toUid = (request.data && request.data.toUid) || null;

  if (typeof toUid !== 'string' || !toUid) {
    throw new HttpsError('invalid-argument', 'toUid が不正です');
  }
  if (toUid === uid) {
    throw new HttpsError('invalid-argument', '自分自身をフレンドに追加することはできません');
  }

  const userRef = db.collection('users').doc(uid);
  const toUserRef = db.collection('users').doc(toUid);

  const toUserSnap = await toUserRef.get();
  if (!toUserSnap.exists) {
    throw new HttpsError('not-found', '指定されたユーザーが見つかりません');
  }

  const friendRef = userRef.collection('friends').doc(toUid);
  if ((await friendRef.get()).exists) {
    throw new HttpsError('already-exists', 'すでにフレンドです');
  }

  const sentRef = userRef.collection('sentFriendRequests').doc(toUid);
  const incomingRef = toUserRef.collection('friendRequests').doc(uid);

  if ((await sentRef.get()).exists) {
    throw new HttpsError('already-exists', 'すでにリクエストを送信済みです');
  }

  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};

  const now = Timestamp.now();
  if (userData.lastFriendRequestAt) {
    const sinceLast = now.toMillis() - userData.lastFriendRequestAt.toMillis();
    if (sinceLast < FRIEND_REQUEST_COOLDOWN_MS) {
      throw new HttpsError('resource-exhausted', '送信間隔が短すぎます。しばらく待ってから再度お試しください');
    }
  }

  const pendingSentCount = typeof userData.pendingSentCount === 'number' ? userData.pendingSentCount : 0;
  if (pendingSentCount >= MAX_PENDING_SENT_REQUESTS) {
    throw new HttpsError('resource-exhausted', '未承認のリクエストが多すぎます。相手の承認を待つか、キャンセルしてください');
  }

  // 相手が同時に自分へ既にリクエストを送っていた場合は、送信済みリクエストとして扱わせず
  // 相互承認扱い（自動でフレンド成立）にする方が親切だが、まずはシンプルに拒否する。
  const reverseIncomingRef = userRef.collection('friendRequests').doc(toUid);
  if ((await reverseIncomingRef.get()).exists) {
    throw new HttpsError('already-exists', '相手からのリクエストが届いています。そちらを承認してください');
  }

  const batch = db.batch();
  batch.set(incomingRef, {
    fromNickname: (typeof userData.nickname === 'string' && userData.nickname) ? userData.nickname : null,
    fromCode: (typeof userData.friendCode === 'string' && userData.friendCode) ? userData.friendCode : null,
    createdAt: FieldValue.serverTimestamp()
  });
  batch.set(sentRef, { createdAt: FieldValue.serverTimestamp() });
  batch.set(userRef, {
    lastFriendRequestAt: FieldValue.serverTimestamp(),
    pendingSentCount: pendingSentCount + 1
  }, { merge: true });
  await batch.commit();

  return { ok: true };
});

/**
 * 送信済みフレンドリクエストのキャンセル（送信者側から取り消す）。
 */
exports.cancelFriendRequest = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const toUid = (request.data && request.data.toUid) || null;
  if (typeof toUid !== 'string' || !toUid) {
    throw new HttpsError('invalid-argument', 'toUid が不正です');
  }

  const userRef = db.collection('users').doc(uid);
  const sentRef = userRef.collection('sentFriendRequests').doc(toUid);
  const incomingRef = db.collection('users').doc(toUid).collection('friendRequests').doc(uid);

  const sentSnap = await sentRef.get();
  if (!sentSnap.exists) {
    // 既に存在しない（相手に承認/拒否された、もしくは二重キャンセル）場合は成功扱いで良い
    return { ok: true };
  }

  const userSnap = await userRef.get();
  const pendingSentCount = userSnap.exists && typeof userSnap.data().pendingSentCount === 'number'
    ? userSnap.data().pendingSentCount
    : 0;

  const batch = db.batch();
  batch.delete(sentRef);
  batch.delete(incomingRef);
  batch.set(userRef, { pendingSentCount: Math.max(0, pendingSentCount - 1) }, { merge: true });
  await batch.commit();

  return { ok: true };
});

/**
 * フレンドリクエストの承認。双方の friends サブコレクションに1件ずつ作成し、
 * 該当するリクエスト記録（friendRequests / sentFriendRequests）を削除する。
 */
exports.acceptFriendRequest = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const fromUid = (request.data && request.data.fromUid) || null;
  if (typeof fromUid !== 'string' || !fromUid) {
    throw new HttpsError('invalid-argument', 'fromUid が不正です');
  }

  const myRef = db.collection('users').doc(uid);
  const incomingRef = myRef.collection('friendRequests').doc(fromUid);
  const incomingSnap = await incomingRef.get();
  if (!incomingSnap.exists) {
    throw new HttpsError('not-found', 'そのフレンドリクエストは見つかりませんでした（キャンセル済みの可能性があります）');
  }

  const fromRef = db.collection('users').doc(fromUid);
  const sentRef = fromRef.collection('sentFriendRequests').doc(uid);
  const fromUserSnap = await fromRef.get();
  const pendingSentCount = fromUserSnap.exists && typeof fromUserSnap.data().pendingSentCount === 'number'
    ? fromUserSnap.data().pendingSentCount
    : 0;

  const batch = db.batch();
  batch.set(myRef.collection('friends').doc(fromUid), { createdAt: FieldValue.serverTimestamp() });
  batch.set(fromRef.collection('friends').doc(uid), { createdAt: FieldValue.serverTimestamp() });
  batch.delete(incomingRef);
  batch.delete(sentRef);
  batch.set(fromRef, { pendingSentCount: Math.max(0, pendingSentCount - 1) }, { merge: true });
  await batch.commit();

  return { ok: true };
});

/**
 * フレンドリクエストの拒否。フレンド関係は作らず、リクエスト記録だけを削除する。
 */
exports.declineFriendRequest = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const fromUid = (request.data && request.data.fromUid) || null;
  if (typeof fromUid !== 'string' || !fromUid) {
    throw new HttpsError('invalid-argument', 'fromUid が不正です');
  }

  const myRef = db.collection('users').doc(uid);
  const incomingRef = myRef.collection('friendRequests').doc(fromUid);
  const fromRef = db.collection('users').doc(fromUid);
  const sentRef = fromRef.collection('sentFriendRequests').doc(uid);

  const fromUserSnap = await fromRef.get();
  const pendingSentCount = fromUserSnap.exists && typeof fromUserSnap.data().pendingSentCount === 'number'
    ? fromUserSnap.data().pendingSentCount
    : 0;

  const batch = db.batch();
  batch.delete(incomingRef);
  batch.delete(sentRef);
  batch.set(fromRef, { pendingSentCount: Math.max(0, pendingSentCount - 1) }, { merge: true });
  await batch.commit();

  return { ok: true };
});

/**
 * 使用済み・期限切れの rounds トークンを定期的に掃除し、データベースの肥大化を防ぐ。
 */
exports.cleanupRounds = onSchedule('every 24 hours', async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
  const usersSnap = await db.collection('users').select().get();
  for (const userDoc of usersSnap.docs) {
    const roundsSnap = await userDoc.ref.collection('rounds').where('armedAt', '<', cutoff).get();
    if (roundsSnap.empty) continue;
    const batch = db.batch();
    roundsSnap.docs.forEach(function (d) { batch.delete(d.ref); });
    await batch.commit();
  }
});
