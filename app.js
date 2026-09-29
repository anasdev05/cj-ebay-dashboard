const API_BASE = String(window.CJ_EBAY_API_BASE || '').replace(/\/$/, '');
const API = `${API_BASE}/api/opportunities`;
const RUN = `${API_BASE}/api/run`;
const DECISION = `${API_BASE}/api/decision`;
const RUN_TIMEOUT_MS = 6 * 60 * 1000;

const money = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : '—';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const runUi = {
  running: false,
  startedAt: 0,
  elapsedTimer: null,
  refreshTimer: null,
  refreshBusy: false,
  baselineVersion: '',
  baselineExecutionId: 0,
  executionId: null,
};

function dataVersion(data) {
  return (data.opportunities || []).map((item) => [
    item.id,
    item.generatedAt,
    item.freightQuotedAt,
    item.profitabilityCalculatedAt,
    item.reviewStatus,
    item.sellerDecision,
  ].join(':')).join('|');
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function setMonitor(state, title, detail = '') {
  const monitor = document.querySelector('#run-monitor');
  monitor.hidden = false;
  monitor.dataset.state = state;
  document.querySelector('#run-monitor-title').textContent = title;
  document.querySelector('#run-monitor-detail').textContent = detail;
}

function card(item) {
  const review = item.aiReview;
  const taxonomy = item.ebayTaxonomy;
  const decision = item.sellerDecision || 'PENDING';
  return `<article class="panel product-card"><div class="panel-title"><div><p class="eyebrow">${esc(item.reviewStatus || 'NEW')}</p><h2 dir="auto">${esc(item.title)}</h2></div><span class="decision-badge ${review?.decision === 'RELEVANT' ? 'ok' : 'warning'}">${esc(review?.decision || 'بانتظار AI')}</span></div><div class="metrics"><span>سعر CJ<b dir="ltr">${money(item.cjPrice)}</b></span><span>الشحن<b dir="ltr">${money(item.shipping)}</b></span><span>التكلفة الواصلة<b dir="ltr">${money(item.landedCost)}</b></span><span>سعر eBay المقارن<b dir="ltr">${money(item.ebayMedian)}</b></span><span>الربح<b dir="ltr">${money(item.profit)}</b></span><span>هامش الربح<b dir="ltr">${item.margin ?? '—'}%</b></span></div><div class="review-box"><p dir="auto"><b>AI:</b> ${esc(review?.reason || 'لم تُنفذ المراجعة')}</p><p><b>تصنيف eBay:</b> <span dir="auto">${esc(taxonomy?.categoryName || '—')}</span> ${taxonomy?.categoryId ? `(<span dir="ltr">${esc(taxonomy.categoryId)}</span>)` : ''}</p><p><b>الخصائص الإلزامية:</b> ${taxonomy?.requiredAspectCount ?? '—'}</p></div>${review ? `<div class="decision-actions"><button data-key="${esc(item.id)}" data-decision="APPROVE" class="approve ${decision === 'APPROVED' ? 'selected' : ''}">موافقة</button><button data-key="${esc(item.id)}" data-decision="REJECT" class="reject ${decision === 'REJECTED' ? 'selected' : ''}">رفض</button><span dir="ltr">${esc(decision)}</span></div>` : ''}<p class="gate">${item.readyForEbayDraft ? 'جاهز للمسودة' : 'الموافقة تنقله لإعداد المسودة؛ النشر يبقى منفصلًا'}</p></article>`;
}

function syncExecutionState(data) {
  const execution = data.execution;
  const button = document.querySelector('#execute');
  if (!execution) return;
  if (execution.status === 'running') {
    if (!runUi.running) beginRunningUi(button, Date.parse(execution.startedAt) || Date.now());
    runUi.executionId = Number(execution.id);
    setMonitor('running', `التنفيذ ${execution.id} شغّال داخل n8n`, 'الحالة مقروءة مباشرة من قاعدة n8n، والنتائج تتحدث تلقائيًا.');
    return;
  }
  const belongsToCurrentRun = runUi.executionId
    ? Number(execution.id) === Number(runUi.executionId)
    : Number(execution.id) > Number(runUi.baselineExecutionId || 0);
  if (!runUi.running || !belongsToCurrentRun) return;
  const seconds = Math.max(0, Math.round((Date.parse(execution.stoppedAt) - Date.parse(execution.startedAt)) / 1000));
  if (execution.status === 'success' && execution.stoppedAt) {
    setMonitor('success', `اكتمل التنفيذ ${execution.id} وتم تحميل النتائج`, `أكدت قاعدة n8n توقف التنفيذ بحالة success خلال ${seconds} ثانية.`);
  } else {
    setMonitor('error', `انتهى التنفيذ ${execution.id} بحالة ${execution.status}`, 'افتح تبويب Executions في n8n لمراجعة العقدة التي توقفت.');
  }
  finishRunningUi(button);
}

async function load({ silent = false, syncExecution = true } = {}) {
  const connection = document.querySelector('#connection');
  try {
    const response = await fetch(API, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const reviewed = data.opportunities.filter((item) => item.aiReview);
    connection.textContent = runUi.running ? 'متصل · التنفيذ جارٍ' : (data.workflow?.hasUnpublishedChanges ? 'متصل · يوجد تعديل غير منشور في n8n' : 'متصل ببيانات n8n الحية');
    document.querySelector('#reviewed-count').textContent = reviewed.length;
    document.querySelector('#generated-at').textContent = new Date(data.generatedAt).toLocaleString('ar-SA');
    document.querySelector('#summary').textContent = `${data.count} فرصة · ${reviewed.length} مراجعات`;
    document.querySelector('#cards').innerHTML = data.opportunities.filter((item) => item.profitDecision).map(card).join('') || '<article class="panel">لا توجد فرص مربحة بعد.</article>';
    if (syncExecution) syncExecutionState(data);
    return { data, version: dataVersion(data) };
  } catch (error) {
    connection.textContent = 'تعذر الاتصال';
    if (!silent) document.querySelector('#cards').innerHTML = `<article class="panel">فشل التحميل: ${esc(error.message)}</article>`;
    throw error;
  }
}

function beginRunningUi(button, startedAt = Date.now()) {
  if (runUi.running) return;
  runUi.running = true;
  runUi.startedAt = startedAt;
  button.disabled = true;
  button.classList.add('is-running');
  button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span>المسار يعمل الآن';
  setMonitor('running', 'التنفيذ شغّال داخل n8n', 'الطلب ما زال مفتوحًا، والنتائج تُفحص تلقائيًا كل 4 ثوانٍ.');
  document.querySelector('#run-elapsed').textContent = '00:00';
  runUi.elapsedTimer = setInterval(() => {
    document.querySelector('#run-elapsed').textContent = formatDuration(Date.now() - runUi.startedAt);
  }, 1000);
  runUi.refreshTimer = setInterval(async () => {
    if (runUi.refreshBusy) return;
    runUi.refreshBusy = true;
    try {
      const latest = await load({ silent: true });
      if (latest.version && latest.version !== runUi.baselineVersion) {
        runUi.baselineVersion = latest.version;
        setMonitor('running', 'التنفيذ شغّال والنتائج تتحدث', 'وصلت بيانات جديدة من إحدى المراحل وعُرضت فورًا. ننتظر إشارة الاكتمال من نفس التنفيذ.');
      }
    } catch { /* The main request remains the source of truth. */ }
    finally { runUi.refreshBusy = false; }
  }, 4000);
}

function finishRunningUi(button) {
  runUi.running = false;
  clearInterval(runUi.elapsedTimer);
  clearInterval(runUi.refreshTimer);
  runUi.elapsedTimer = null;
  runUi.refreshTimer = null;
  button.disabled = false;
  button.classList.remove('is-running');
  button.textContent = 'تشغيل المسار الآن';
}

async function waitForTerminalExecution() {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (runUi.running && Date.now() < deadline) {
    await load({ silent: true });
    if (!runUi.running) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (runUi.running) throw new Error('وصل رد الـWebhook لكن n8n لم يؤكد توقف التنفيذ بعد. استمر بالمراقبة من حالة التنفيذ الظاهرة.');
}

document.querySelector('#refresh').addEventListener('click', () => load().catch(() => {}));
async function runUnifiedPipeline(event) {
  const button = event.currentTarget;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  beginRunningUi(button);
  try {
    const baseline = await load({ silent: true, syncExecution: false });
    runUi.baselineVersion = baseline.version;
    runUi.baselineExecutionId = Number(baseline.data.execution?.id || 0);
    runUi.executionId = null;
    const response = await fetch(RUN, {
      method: 'POST',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409 && payload.alreadyRunning) {
      runUi.executionId = Number(payload.executionId);
      setMonitor('running', `التنفيذ ${payload.executionId} يعمل مسبقًا`, 'لن نبدأ تنفيذًا ثانيًا؛ الداشبورد يراقب التنفيذ الحالي حتى يتوقف.');
      await waitForTerminalExecution();
      return;
    }
    if (!response.ok || payload.success !== true) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    await waitForTerminalExecution();
  } catch (error) {
    const message = error.name === 'AbortError' ? 'تجاوز التنفيذ 6 دقائق. افحص Execution في n8n؛ لم نعلن نجاحًا غير مؤكد.' : error.message;
    if (runUi.running) {
      setMonitor('error', 'لم يؤكد n8n اكتمال التنفيذ', message);
      finishRunningUi(button);
    }
  } finally {
    clearTimeout(timeout);
  }
}
const executeButton = document.querySelector('#execute');
executeButton.addEventListener('click', runUnifiedPipeline);
executeButton.dataset.handlerReady = 'true';

document.querySelector('#cards').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-decision]');
  if (!button) return;
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'جارٍ الحفظ…';
  try {
    const response = await fetch(DECISION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ opportunityKey: button.dataset.key, decision: button.dataset.decision }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await load();
  } catch (error) {
    alert(`تعذر حفظ القرار: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
});

load().catch(() => {});
setInterval(() => load({ silent: true }).catch(() => {}), 5000);
