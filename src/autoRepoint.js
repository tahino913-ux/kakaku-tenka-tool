'use strict';
// =====================================================================
//  コード再利用の「📌貼り替え忘れ」を、取込＋↻照合だけで自動修復する。
//   linkSwapAudit が検知した swap（📌が旧品を指したまま＝マスタ名と品番が完全に別物）のうち、
//   入れ替え先の“新品”が今のメーカー見積に実在するものだけ、📌を自動で新品へ張り替える。
//   ＝利用者が「解除→新📌」の2手を踏まなくても、見積を取り込んで照合すれば直る。
//
//   安全の肝：
//    ・検知は linkSwapAudit（実データ誤検知0の保守判定）に乗る＝暴発しない。
//    ・入れ替え先が“現マスタ名に完全一致”するメーカー品として実在するときだけ動く
//      （入替先が無ければ触らない＝コードを休眠化させない）。
//    ・入替先が複数供給元/複数名で曖昧なときは自動化せず人に委ねる。
//    ・張り替えは可逆（settings の📌操作）＋実行内容を記録して通知＝静かに変えない
//      （[[prefer-flag-bad-data-not-auto-fix]] の「人が後で確認できる」を満たす自動化）。
// =====================================================================
const { linkNamesEqual } = require('./productLink');

// swapIssues: auditLinkSwaps().issues = [{ supplier, code, linked(旧メーカー名), master(新マスタ名) }]
// makerItems: マージ済みメーカー見積の全品（flattenedMergedMakerItems 相当。{ supplier, makerName } を読む）
// 戻り値: [{ oldSupplier, code, oldName, newSupplier, newName }]（実際に張り替えるべき指示）
function planRepoints(swapIssues, makerItems) {
  const items = (makerItems || [])
    .map((it) => ({ supplier: String((it && it.supplier) || '').trim(), name: String((it && it.makerName) || '').trim() }))
    .filter((it) => it.name);
  const plans = [];
  for (const iss of swapIssues || []) {
    const master = String((iss && iss.master) || '').trim();
    if (!master) continue;
    // 現マスタ名に完全一致（表記ゆれ吸収）するメーカー品＝入れ替え先が実在するか。
    const hits = items.filter((it) => linkNamesEqual(it.name, master));
    if (!hits.length) continue;                              // 入替先が見積に無い＝触らない
    const names = [...new Set(hits.map((h) => h.name))];
    const sups = [...new Set(hits.map((h) => h.supplier))];
    if (names.length !== 1 || sups.length !== 1) continue;   // 複数名/複数供給元＝曖昧＝自動化しない
    const newName = names[0];
    const newSupplier = sups[0];
    // 既に正しく張られている（同一供給元・同一名）なら何もしない。
    if (newSupplier === iss.supplier && linkNamesEqual(newName, iss.linked)) continue;
    plans.push({ oldSupplier: String(iss.supplier || ''), code: String(iss.code || ''), oldName: String(iss.linked || ''), newSupplier, newName });
  }
  return plans;
}

// 単体検証（node src/autoRepoint.js）
function selfTest() {
  const swaps = [
    // 入替先(FLB-A13-20 W)が見積にある → コパックス→朝日 へ張り替え
    { supplier: 'コパックス 本部業務課', code: '002050', linked: 'Vトレー V－79', master: 'ﾄﾚｰFLB-A13-20　W' },
    // 入替先が見積に無い → 触らない（休眠化させない）
    { supplier: 'コパックス 本部業務課', code: '002099', linked: 'Vトレー V－9', master: 'ﾄﾚｰFLB-XX-99　W' },
  ];
  const makerItems = [
    { supplier: '朝日食品容器', makerName: 'ﾄﾚｰFLB-A13-20　W' },
    { supplier: '朝日食品容器', makerName: 'その他の品' },
  ];
  const plans = planRepoints(swaps, makerItems);
  const ok = plans.length === 1
    && plans[0].code === '002050'
    && plans[0].oldSupplier === 'コパックス 本部業務課'
    && plans[0].newSupplier === '朝日食品容器'
    && linkNamesEqual(plans[0].newName, 'ﾄﾚｰFLB-A13-20　W');
  // 入替先が複数供給元に同名で存在＝曖昧 → 自動化しない
  const ambiguous = planRepoints([swaps[0]], [
    { supplier: '朝日食品容器', makerName: 'ﾄﾚｰFLB-A13-20　W' },
    { supplier: 'エフピコ', makerName: 'ﾄﾚｰFLB-A13-20　W' },
  ]);
  const ok2 = ambiguous.length === 0;
  // 入替先が無い（別品しかない）→ 空
  const none = planRepoints([swaps[0]], [{ supplier: '朝日食品容器', makerName: '全然ちがう品' }]);
  const ok3 = none.length === 0;
  if (!ok || !ok2 || !ok3) {
    console.error('autoRepoint selfTest FAILED', JSON.stringify({ plans, ambiguous, none }, null, 2));
    process.exit(1);
  }
  console.log('autoRepoint selfTest OK');
}

if (require.main === module) selfTest();

module.exports = { planRepoints, selfTest };
