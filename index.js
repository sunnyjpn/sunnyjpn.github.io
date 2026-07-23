const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// ---- ランキング荒らし対策のパラメータ ----
const MIN_MS = 100;                // 許容する反応時間の下限（クライアント側 MIN_REACTION_MS と揃える）
const MAX_MS = 1000;               // 許容する反応時間の上限
const MIN_WAIT_FLOOR_MS = 1500;    // 実際の待機は2000〜5000msあるため、安全マージンを引いた最低ライン
const ROUND_EXPIRY_MS = 60 * 1000; // startRound発行から60秒以内に送信すること（放置トークンの悪用防止）
const SUBMIT_COOLDOWN_MS = 5000;   // 1ユーザーが連続でスコアを送信できる最短間隔（5秒に1回で十分）
const RECENT_RAW_MAX = 8;          // 同一値の連続検知に使う直近の生スコア保持数
const REPEAT_FLAG_THRESHOLD = 6;   // 直近8件中6件以上が同一(丸め一致)ならBot疑いとしてフラグ
const TOO_FAST_STREAK_LIMIT = 100; // MIN_MS未満の「Too soon!」判定が連続でこの回数に達したらBAN
const BAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // BAN期間（30日）

// ---- フレンド機能の荒らし対策パラメータ ----
const FRIEND_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0,O,1,I)を除外
const FRIEND_CODE_ATTEMPT_COOLDOWN_MS = 3000;   // フレンドID発行の連打防止
const FRIEND_REQUEST_COOLDOWN_MS = 3000;        // フレンドリクエスト送信の連打防止
const MAX_PENDING_SENT_REQUESTS = 30;           // 1ユーザーが同時に送信できる未処理リクエストの上限

/**
 * ラウンド開始トークンの発行。
 * クライアントは「待機画面（赤→緑への遷移）」を表示する直前にこれを呼び、
 * 返ってきた roundId を保持しておく。
 * armedAt はサーバー時刻（Admin SDKのserverTimestamp）で記録するため、
 * クライアント側で改ざんすることはできない。
 */
exports.startRound = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const user = userSnap.exists ? userSnap.data() : {};
  if (user.bannedUntil && user.bannedUntil.toMillis() > Date.now()) {
    throw new HttpsError('permission-denied', 'アカウントが一時的に利用停止中です');
  }
  const roundRef = userRef.collection('rounds').doc();
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
exports.submitScore = onCall(async (request) => {
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
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms > MAX_MS) {
    throw new HttpsError('invalid-argument', 'スコアが許容範囲外です');
  }

  const userRef = db.collection('users').doc(uid);

  // MIN_MS未満（Too soon! 判定）は、見た目はこれまで通り「スコアが許容範囲外です」で
  // 弾きつつ、裏で連続回数だけをカウントする。連続 TOO_FAST_STREAK_LIMIT 回に達したら
  // 30日間のBANを課す。クライアント側には一切気づかれない（判定・メッセージは従来と同一）。
  if (ms < MIN_MS) {
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const user = userSnap.exists ? userSnap.data() : {};
      const now = Timestamp.now();

      // 既にBAN中なら、streakは触らずそのまま素通り（下で同じエラーを投げる）
      if (user.bannedUntil && user.bannedUntil.toMillis() > now.toMillis()) {
        return;
      }

      const streak = (typeof user.tooFastStreak === 'number' ? user.tooFastStreak : 0) + 1;
      const payload = { tooFastStreak: streak };
      if (streak >= TOO_FAST_STREAK_LIMIT) {
        payload.tooFastStreak = 0;
        payload.bannedUntil = Timestamp.fromMillis(now.toMillis() + BAN_DURATION_MS);
      }
      tx.set(userRef, payload, { merge: true });
    });
    throw new HttpsError('invalid-argument', 'スコアが許容範囲外です');
  }

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

    if (user.bannedUntil && user.bannedUntil.toMillis() > now.toMillis()) {
      throw new HttpsError('permission-denied', 'アカウントが一時的に利用停止中です');
    }

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
      tooFastStreak: 0,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (!userSnap.exists) payload.createdAt = FieldValue.serverTimestamp();

    tx.set(userRef, payload, { merge: true });
    tx.update(roundRef, { used: true });

    return { bestScore: bestScore, attemptCount: attemptCount, totalTimeSum: totalTimeSum, isNewBest: isNewBest, suspicious: suspicious };
  });

  return Object.assign({ ok: true }, result);
});

// ------------------------------------------------------------------
// フレンド機能（サーバー側で発行・レート制限・不整合防止をまとめて行う）
// クライアントSDKからの直接書き込みは firestore.rules で禁止し、
// 必ずこれらの Cloud Functions を経由させる。
// ------------------------------------------------------------------

function generateCandidateFriendCode() {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += FRIEND_CODE_CHARS.charAt(Math.floor(Math.random() * FRIEND_CODE_CHARS.length));
  }
  return 'SUN-' + s;
}

/**
 * フレンドIDの発行（未発行なら新規発行、発行済みならそれを返す）。
 * 「誰でも何度でも呼べる」対策として、初回発行前のみクールダウンを設ける
 * （発行済みなら早期リターンするだけなので、そちらは連打されても実害がない）。
 */
exports.ensureFriendCode = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const user = snap.exists ? snap.data() : {};

  if (typeof user.friendCode === 'string' && user.friendCode) {
    return { friendCode: user.friendCode };
  }

  const now = Date.now();
  if (user.friendCodeAttemptAt && now - user.friendCodeAttemptAt.toMillis() < FRIEND_CODE_ATTEMPT_COOLDOWN_MS) {
    throw new HttpsError('resource-exhausted', '送信間隔が短すぎます。しばらく待ってから再度お試しください');
  }
  await userRef.set({ friendCodeAttemptAt: FieldValue.serverTimestamp() }, { merge: true });

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCandidateFriendCode();
    const codeRef = db.collection('friendCodes').doc(code);
    try {
      const assigned = await db.runTransaction(async (tx) => {
        const [codeSnap, userSnap2] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);
        const userData2 = userSnap2.exists ? userSnap2.data() : {};
        // トランザクション中に別リクエストが先に発行していた場合はそれを採用する
        if (typeof userData2.friendCode === 'string' && userData2.friendCode) {
          return userData2.friendCode;
        }
        if (codeSnap.exists) return null; // 衝突。次のcodeで再試行
        tx.set(codeRef, { uid: uid, createdAt: FieldValue.serverTimestamp() });
        tx.set(userRef, { friendCode: code }, { merge: true });
        return code;
      });
      if (assigned) return { friendCode: assigned };
    } catch (e) {
      // このcodeでの発行に失敗した場合は次の候補で再試行する
    }
  }
  throw new HttpsError('internal', 'フレンドIDの発行に失敗しました。しばらくしてからお試しください');
});

/**
 * フレンドリクエストの送信。
 * ・自分自身への送信、既にフレンドの相手への送信は拒否
 * ・二重送信はトランザクション内で再確認して防止
 * ・送信間隔のクールダウンと、未処理リクエスト数の上限でスパムを抑制
 */
exports.sendFriendRequest = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const currentUid = request.auth.uid;
  const toUid = request.data && request.data.toUid;
  if (typeof toUid !== 'string' || !toUid || toUid === currentUid) {
    throw new HttpsError('invalid-argument', '送信先が不正です');
  }

  const myRef = db.collection('users').doc(currentUid);
  const requestRef = db.collection('users').doc(toUid).collection('friendRequests').doc(currentUid);
  const sentRef = myRef.collection('sentFriendRequests').doc(toUid);
  const myFriendRef = myRef.collection('friends').doc(toUid);

  const result = await db.runTransaction(async (tx) => {
    const [mySnap, sentSnap, friendSnap] = await Promise.all([
      tx.get(myRef),
      tx.get(sentRef),
      tx.get(myFriendRef)
    ]);

    if (friendSnap.exists) {
      return { ok: false, reason: 'already-friend' };
    }
    if (sentSnap.exists) {
      return { ok: false, reason: 'already-pending' };
    }

    const myData = mySnap.exists ? mySnap.data() : {};
    const now = Timestamp.now();

    if (myData.lastFriendRequestAt && now.toMillis() - myData.lastFriendRequestAt.toMillis() < FRIEND_REQUEST_COOLDOWN_MS) {
      throw new HttpsError('resource-exhausted', '送信間隔が短すぎます。しばらく待ってから再度お試しください');
    }

    const pendingSentCount = typeof myData.pendingSentCount === 'number' ? myData.pendingSentCount : 0;
    if (pendingSentCount >= MAX_PENDING_SENT_REQUESTS) {
      throw new HttpsError('resource-exhausted', '送信中のフレンドリクエストが多すぎます。返信を待ってから送ってください');
    }

    tx.set(requestRef, {
      fromUid: currentUid,
      fromNickname: typeof myData.nickname === 'string' ? myData.nickname : '',
      fromCode: typeof myData.friendCode === 'string' ? myData.friendCode : '',
      createdAt: FieldValue.serverTimestamp(),
      status: 'pending'
    });
    tx.set(sentRef, { toUid: toUid, createdAt: FieldValue.serverTimestamp() });
    tx.set(myRef, {
      lastFriendRequestAt: FieldValue.serverTimestamp(),
      pendingSentCount: pendingSentCount + 1
    }, { merge: true });

    return { ok: true };
  });

  return result;
});

/**
 * 送信済みフレンドリクエストのキャンセル（送信者本人のみ）。
 */
exports.cancelFriendRequest = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const currentUid = request.auth.uid;
  const toUid = request.data && request.data.toUid;
  if (typeof toUid !== 'string' || !toUid) {
    throw new HttpsError('invalid-argument', '送信先が不正です');
  }

  const myRef = db.collection('users').doc(currentUid);
  const requestRef = db.collection('users').doc(toUid).collection('friendRequests').doc(currentUid);
  const sentRef = myRef.collection('sentFriendRequests').doc(toUid);

  await db.runTransaction(async (tx) => {
    const sentSnap = await tx.get(sentRef);
    if (!sentSnap.exists) return; // 既に処理済み・キャンセル済み
    const mySnap = await tx.get(myRef);
    const myData = mySnap.exists ? mySnap.data() : {};
    const pendingSentCount = typeof myData.pendingSentCount === 'number' ? myData.pendingSentCount : 0;

    tx.delete(requestRef);
    tx.delete(sentRef);
    tx.set(myRef, { pendingSentCount: Math.max(0, pendingSentCount - 1) }, { merge: true });
  });

  return { ok: true };
});

/**
 * フレンドリクエストの承認（受信者本人のみ）。
 * 双方の friends サブコレクションへの書き込みとリクエストの削除を
 * 1つのトランザクションにまとめ、片側だけ成立するような不整合を防ぐ。
 */
exports.acceptFriendRequest = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const currentUid = request.auth.uid;
  const fromUid = request.data && request.data.fromUid;
  if (typeof fromUid !== 'string' || !fromUid) {
    throw new HttpsError('invalid-argument', '相手の指定が不正です');
  }

  const myFriendRef = db.collection('users').doc(currentUid).collection('friends').doc(fromUid);
  const otherFriendRef = db.collection('users').doc(fromUid).collection('friends').doc(currentUid);
  const requestRef = db.collection('users').doc(currentUid).collection('friendRequests').doc(fromUid);
  const senderRef = db.collection('users').doc(fromUid);
  const senderSentRef = senderRef.collection('sentFriendRequests').doc(currentUid);

  await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists) {
      throw new HttpsError('failed-precondition', 'このリクエストは既に処理されています');
    }
    const senderSnap = await tx.get(senderRef);
    const senderData = senderSnap.exists ? senderSnap.data() : {};
    const pendingSentCount = typeof senderData.pendingSentCount === 'number' ? senderData.pendingSentCount : 0;

    tx.set(myFriendRef, { since: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(otherFriendRef, { since: FieldValue.serverTimestamp() }, { merge: true });
    tx.delete(requestRef);
    tx.delete(senderSentRef);
    tx.set(senderRef, { pendingSentCount: Math.max(0, pendingSentCount - 1) }, { merge: true });
  });

  return { ok: true };
});

/**
 * フレンドリクエストの拒否（受信者本人のみ）。
 */
exports.declineFriendRequest = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const currentUid = request.auth.uid;
  const fromUid = request.data && request.data.fromUid;
  if (typeof fromUid !== 'string' || !fromUid) {
    throw new HttpsError('invalid-argument', '相手の指定が不正です');
  }

  const requestRef = db.collection('users').doc(currentUid).collection('friendRequests').doc(fromUid);
  const senderRef = db.collection('users').doc(fromUid);
  const senderSentRef = senderRef.collection('sentFriendRequests').doc(currentUid);

  await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists) return; // 既に処理済み
    const senderSnap = await tx.get(senderRef);
    const senderData = senderSnap.exists ? senderSnap.data() : {};
    const pendingSentCount = typeof senderData.pendingSentCount === 'number' ? senderData.pendingSentCount : 0;

    tx.delete(requestRef);
    tx.delete(senderSentRef);
    tx.set(senderRef, { pendingSentCount: Math.max(0, pendingSentCount - 1) }, { merge: true });
  });

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
