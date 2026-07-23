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
// 注：App Checkはクライアント側（index.html）で現在無効化中（プレースホルダーの
//     reCAPTCHA v3サイトキーのままでは有効なトークンを取得できないため）。
//     それに合わせてこちら（Functions側）も enforceAppCheck: false にしてある。
//     クライアント側を有効化する場合は、正しいサイトキーに差し替えた上で
//     こちらも true に戻すこと（片方だけ有効化すると、startRound / submitScore が
//     全滅する＝反応時間がクラウドに一切保存できなくなるので要注意）。
const MIN_MS = 50;                 // 許容する反応時間の下限
const MAX_MS = 1000;               // 許容する反応時間の上限
const MIN_WAIT_FLOOR_MS = 1500;    // 実際の待機は2000〜5000msあるため、安全マージンを引いた最低ライン
const ROUND_EXPIRY_MS = 60 * 1000; // startRound発行から60秒以内に送信すること（放置トークンの悪用防止）
const SUBMIT_COOLDOWN_MS = 5000;   // 1ユーザーが連続でスコアを送信できる最短間隔（5秒に1回で十分）
const RECENT_RAW_MAX = 8;          // 同一値の連続検知に使う直近の生スコア保持数
const REPEAT_FLAG_THRESHOLD = 6;   // 直近8件中6件以上が同一(丸め一致)ならBot疑いとしてフラグ

/**
 * ラウンド開始トークンの発行。
 * クライアントは「待機画面（赤→緑への遷移）」を表示する直前にこれを呼び、
 * 返ってきた roundId を保持しておく。
 * armedAt はサーバー時刻（Admin SDKのserverTimestamp）で記録するため、
 * クライアント側で改ざんすることはできない。
 */
exports.startRound = onCall({ enforceAppCheck: false }, async (request) => {
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
exports.submitScore = onCall({ enforceAppCheck: false }, async (request) => {
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
