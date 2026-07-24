const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// ---- ランキング荒らし対策のパラメータ ----
const MIN_MS = 0;                  // 許容する反応時間の下限
const MAX_MS = 1000;               // 許容する反応時間の上限
const MIN_WAIT_FLOOR_MS = 400;     // 実際の待機は500〜1500msのため、安全マージンを引いた最低ライン
const ROUND_EXPIRY_MS = 60 * 1000; // startRound発行から60秒以内に送信すること（放置トークンの悪用防止）
const SUBMIT_COOLDOWN_MS = 5000;   // 1ユーザーが連続でスコアを送信できる最短間隔（5秒に1回で十分）

/**
 * 表示名・アイコン画像の同期。
 * Googleアカウントの displayName / photoURL は、なりすまし防止のため
 * クライアントからの生値ではなく、Firebase Authが検証済みの
 * request.auth.token（IDトークンのクレーム）からのみ取得する。
 * ・photoURL はここでしか書き込めない（Admin SDK経由のみ）ので、
 *   firestore.rules 側でクライアントに photoURL への書き込みを許可する必要は無い。
 * ・nickname は「まだ一度も自分で設定していない」場合のみ、Googleの表示名で初期値を埋める
 *   （ユーザーが既に設定済みのニックネームを勝手に上書きしない）。
 */
exports.syncProfile = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です');
  }
  const uid = request.auth.uid;
  const token = request.auth.token || {};
  const photoURL = typeof token.picture === 'string' ? token.picture : null;
  const displayName = typeof token.name === 'string' ? token.name.slice(0, 16) : null;

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const existing = snap.exists ? snap.data() : {};

  const payload = {
    photoURL: photoURL,
    updatedAt: FieldValue.serverTimestamp()
  };
  // ニックネーム未設定時のみ、Googleの表示名で初期値を入れる
  if (displayName && (typeof existing.nickname !== 'string' || !existing.nickname)) {
    payload.nickname = displayName;
  }
  if (!snap.exists) {
    payload.createdAt = FieldValue.serverTimestamp();
  }

  await userRef.set(payload, { merge: true });
  return { ok: true, photoURL: photoURL };
});

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
 *   実際のゲームは必ず 500〜1500ms のランダムな待機を挟むため、
 *   正規のプレイであれば経過時間は常に ms + 400ms 以上になるはずである。
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

    const prevBest = typeof user.bestScore === 'number' ? user.bestScore : null;
    const bestScore = prevBest === null ? roundedMs : Math.min(prevBest, roundedMs);
    const isNewBest = prevBest === null || roundedMs < prevBest;
    const attemptCount = (typeof user.attemptCount === 'number' ? user.attemptCount : 0) + 1;

    const payload = {
      bestScore: bestScore,
      attemptCount: attemptCount,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (!userSnap.exists) payload.createdAt = FieldValue.serverTimestamp();

    tx.set(userRef, payload, { merge: true });
    tx.update(roundRef, { used: true });

    return { bestScore: bestScore, attemptCount: attemptCount, isNewBest: isNewBest };
  });

  return Object.assign({ ok: true }, result);
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
