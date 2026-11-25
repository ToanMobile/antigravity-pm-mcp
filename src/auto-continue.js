// Tu lam tiep MOT lan khi han gio cua PM (watchTurn) dung luot implement / rework truoc khi agent ghi result.json moi.
// 25/11: luot implement chay full gate cargo (fmt && clippy && test --workspace) o cuoi, agy cho lenh nen im lang => bi giet o phut 20 / sau 10 phut
// im lang, khong ai lam tiep, task dung im. Mau "nhac 1 lan" giong plan-review.js (planReviewNudge): gui TRUOC, ghi SAU; khoa theo vong (task.round).
// Chay trong pm_status (duong doc): KHONG BAO GIO nem loi, chi tra ve dong bao cao.
import path from 'node:path';
import { contractPaths, addHistory, updateTask, recordDispatch } from './tasks.js';
import { buildAutoContinueMessage } from './prompt.js';
import { sendMessage, humanMs } from './agentapi.js';
import { projectIdFor } from './plan-review.js';
import { ensureDir, writeFileAtomic, nowIso } from './util.js';

export const LAM_TIEP_KINDS = ['implement', 'rework'];

/** "agy turn timed out after 5400000 ms" -> "agy turn timed out after 90 min" (chi de nguoi doc). */
export const lyDoDeDoc = (s) => String(s || '').replace(/(\d+) ms\b/g, (_, n) => humanMs(Number(n)));

/** Loai cua luot vua bi dung: ghi trong su kien loi (ban moi) / so dang ky, roi lan giao gan nhat vao hoi thoai nay (tep cu chua co kind). */
function loaiLuot(task, agyT, end) {
  if (end?.kind) return end.kind;
  if (agyT?.turnKind) return agyT.turnKind;
  const ds = (task.dispatches || []).filter((d) => d.conversationId === task.conversationId && d.kind !== 'open');
  return ds.length ? ds[ds.length - 1].kind : null;
}

/**
 * Dong bao cao cho pm_status + { sent }. Chi lam khi: hoi thoai agy, biet trang thai, luot KHONG chay / khong dang mo, bi watchdog cua PM dung,
 * loai luot implement / rework, result.json chua co / cu hon vong nay, va vong nay chua tu lam tiep lan nao (task.autoContinue.round).
 */
export async function tuLamTiepSauWatchdog(cfg, task, { agyT, end, fresh }) {
  const out = { lines: [], sent: false };
  if (!agyT || agyT.unknown || agyT.running || agyT.starting) return out;
  if (!end?.watchdog || fresh?.resultFresh || task.phase === 'ACCEPTED' || !task.conversationId) return out;
  const kind = loaiLuot(task, agyT, end);
  if (!LAM_TIEP_KINDS.includes(kind)) return out;
  const lyDo = lyDoDeDoc(end.error);
  if (task.autoContinue?.round === task.round) {
    out.lines.push(`  -> da tu lam tiep 1 lan o vong ${task.round} (${task.autoContinue.at}), khong gui lai: PM tu quyet (pm_message / pm_rework / pm_run).`);
    return out;
  }
  const short = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);
  let promptFile;
  try {
    const msg = buildAutoContinueMessage(cfg, task, lyDo);
    promptFile = path.join(ensureDir(contractPaths(cfg, task).logsDir), `prompt-auto-continue-r${task.round}-${Date.now()}.md`);
    writeFileAtomic(promptFile, msg);
    await sendMessage({ conversationId: task.conversationId, projectId: projectIdFor(cfg), content: msg, kind, cfg });
  } catch (e) {
    out.lines.push(`  -> khong tu lam tiep duoc (${short(e)}): pm_message de agent ghi result.json, hoac pm_rework.`);
    return out;
  }
  out.sent = true;
  out.lines.push(`  -> TU LAM TIEP (1 lan, vong ${task.round}): luot ${kind} bi PM dung truoc khi co result.json moi; da gui tin: ${promptFile}. Goi lai pm_status sau vai phut.`);
  try {
    updateTask(cfg, task, (t) => {
      t.autoContinue = { round: t.round, at: nowIso(), kind, reason: lyDo };
      addHistory(t, 'pm', 'auto_continue', lyDo);
    });
    recordDispatch(cfg, task, { kind: 'auto_continue', promptFile });
  } catch (e) {
    out.lines.push(`  -> CHU Y: da gui nhung khong ghi duoc dau "da lam tiep" vao task (${short(e)}): lan pm_status sau co the gui lai.`);
  }
  return out;
}

