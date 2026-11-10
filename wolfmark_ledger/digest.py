"""Local digest: a readable report from existing calculations only.

Builds a Markdown usage summary for a trailing window by transmitting
figures from the analytics, economics, membership and weather builders.
No accounting happens here: numbers and statuses cross from the builders,
while all prose is digest-owned and localised below.

Model rules (each has a regression test):

1. Every figure is transmitted from a builder report, never recomputed.
   Previous-period deltas appear only when the analytics builder marks the
   comparison comparable.
2. API-equivalent value, metered spending, incremental cash and subscription
   fees are reported in separate sections and never summed. The economics
   difference keeps its "estimated value comparison" label; the report
   contains no savings or advice language.
3. Windowed usage figures (trailing days) and current-cycle membership and
   allowance information carry explicit, distinct window labels and are
   never implied to cover the same period.
4. Missing data is never a zero: unrecorded windows read unknown, genuine
   empty windows read zero, and partial windows read observed figures with
   a partial note. Unpriced usage makes values lower bounds, marked as such.
5. Provider-reported allowance information is labelled as such; the digest
   never invents consumption, quotas or forecasts of its own.
6. The report contains no prompts, responses, credentials or identifiers
   beyond account labels already stored in the membership store.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from . import analytics
from . import economics
from . import membership_store as mstore
from . import store as ustore
from .pricing import Catalogue, load_catalogue

#: Report vocabulary and templates. Plain data, deliberately not a framework:
#: new report sentences go here in both languages or not at all.
STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "title": "SpendSense digest",
        "generated": "Generated {ts} UTC",
        "period_days": "Last {days} days ({start} → {end} UTC)",
        "cycle_as_of": "Current cycle, as of {date}",
        "unknown": "—",
        "heading_usage": "Usage",
        "heading_models": "Top models",
        "heading_providers": "Providers",
        "heading_value": "Usage value (API-equivalent)",
        "heading_spending": "Metered and cash spending",
        "heading_fees": "Subscription fees",
        "heading_allowances": "Allowances",
        "heading_changes": "Changes since the previous {days} days",
        "heading_coverage": "Coverage and caveats",
        "heading_methodology": "Methodology",
        "label_calls": "Calls",
        "label_input": "Input tokens",
        "label_output": "Output tokens",
        "label_cache_read": "Cache-read tokens",
        "label_cache_write": "Cache-write tokens",
        "label_api_value": "API-equivalent value",
        "label_pricing_coverage": "Priced tokens",
        "label_unpriced": "Unpriced tokens",
        "label_metered": "Metered (allowance) spending",
        "label_incremental": "Extra cash (incremental) spending",
        "label_credits": "Credits consumed",
        "label_unvalued": "Unclassified calls",
        "label_unpriced_calls": "Unpriced calls",
        "label_provider_charges": "Provider-reported charges",
        "provider_charge_coverage": "({confirmed} of {calls} recorded calls confirmed)",
        "label_fees_monthly": "Known monthly fees ({currency})",
        "label_fees_window": "Fees in window ({currency})",
        "label_usage_value": "Attributed usage value",
        "label_difference": "Estimated value comparison (API-equivalent minus fees)",
        "label_recording_since": "Recording since",
        "label_recording_last": "Last recorded call",
        "label_attributed": "Attributed tokens",
        "label_unattributed": "Unattributed tokens",
        "label_ambiguous": "Ambiguous tokens",
        "change_was": "(was {value})",
        "col_model": "Model",
        "col_provider": "Provider",
        "col_calls": "Calls",
        "col_tokens": "Tokens",
        "col_cost": "API-equiv",
        "col_account": "Account",
        "col_cycle_ends": "Cycle ends",
        "col_days_left": "Days left",
        "col_status": "Status",
        "verdict_ahead": "Ahead of pace",
        "verdict_on_track": "On track",
        "verdict_behind": "Behind pace",
        "verdict_exhausted": "Exhausted",
        "verdict_unknown": "Unknown",
        "note_no_calls": "No calls recorded in this window.",
        "note_partial": "Recording started inside this window, so figures are partial.",
        "note_unknown": "Recording coverage for this window is incomplete, so usage cannot be stated.",
        "note_api_theoretical": "API-equivalent value is a theoretical public price, not an invoice.",
        "note_lower_bound": "Values marked ≥ are lower bounds: some usage is unpriced.",
        "note_unpriced_calls": "{calls} call(s) lack complete usage or price evidence; an unpriced token count of zero does not make their value zero.",
        "note_billing_rule_missing": "{calls} call(s) have no matching billing rule; review the rules in Costs.",
        "note_billing_evidence_missing": "A billing rule matched {calls} call(s), but API price or provider charge evidence is missing; check the price catalogue and recorded charges.",
        "note_billing_rules_unreadable": "Billing rules could not be read, so a match could not be checked for {calls} call(s); repair the rules file and retry.",
        "note_billing_reason_unknown": "{calls} call(s) are unclassified; the record does not say whether no rule matched or price/charge evidence was missing. Review both in Costs.",
        "note_actual_not_recorded": "Actual provider charges are incomplete: some calls lack confirmed per-call records or complete recording coverage.",
        "note_known_monthly_fees": "Known monthly fees are saved subscription declarations, not confirmed payments.",
        "note_unknown_fee_accounts": "{count} subscription fee(s) are unknown; the known subtotal excludes them.",
        "note_historical_fee_missing": "{count} current subscription fee(s) cannot be allocated to this window because historical fee evidence is missing; no effective date is inferred.",
        "note_no_calls_spending": "No calls were recorded in this window.",
        "note_metered_basis": "Metered and cash figures follow your cost rules.",
        "note_fees_prorata": "Fees are allocated pro-rata to the reporting window.",
        "note_partial_comparison": "Some inputs are partial, so treat the comparison as approximate.",
        "note_unavailable_comparison": "Comparison unavailable: fees, coverage or rates are missing.",
        "note_unattributed": "Usage on routes no account claims stays unattributed.",
        "note_ambiguous": "Usage on routes claimed by more than one account is counted once and attributed to nobody.",
        "note_allowance_current": "Allowance status is current, not windowed: it reflects present cycle position.",
        "note_no_memberships": "No memberships on file.",
        "note_no_models": "No models recorded in this window.",
        "note_no_providers": "No providers recorded in this window.",
        "spending_cycle": "Current billing cycles",
        "note_cycle_excluded": "{calls} calls outside current billing cycles are excluded from spending.",
        "note_cash_unknown": "Extra cash cannot be stated without a matching cost rule.",
        "note_credits_unknown": "Credit consumption needs a matching credit rule to be stated.",
        "note_partial_pricing": "Value comparison needs full pricing in both windows.",
        "note_previous_no_calls": "No calls were recorded in the previous window, so percentage changes are unavailable.",
        "note_previous_insufficient": "Not enough recorded history covers the previous window, so changes are unavailable.",
        "note_previous_unavailable": "The previous-window comparison is unavailable.",
        "note_recon_gap": "Recording missed about {tokens} since it began; figures may understate usage.",
        "method_local": "This report is generated locally from your recorded calls and membership store. Nothing leaves your profile unless you export it.",
        "method_windows": "Usage sections cover the trailing window above; allowance status reflects current billing cycles as of generation.",
        "method_value": "API-equivalent value prices recorded tokens at current catalogue rates. It is not what you paid and not what you would pay elsewhere.",
        "method_missing": "A dash means unknown or unavailable, never zero. Zeros appear only where recording genuinely observed nothing.",
    },
    "zh": {
        "title": "SpendSense 摘要",
        "generated": "生成于 {ts} UTC",
        "period_days": "过去 {days} 天（{start} → {end} UTC）",
        "cycle_as_of": "当前周期（截至 {date}）",
        "unknown": "—",
        "heading_usage": "用量",
        "heading_models": "常用模型",
        "heading_providers": "服务商",
        "heading_value": "用量价值（API 等值）",
        "heading_spending": "计量与现金支出",
        "heading_fees": "订阅费用",
        "heading_allowances": "额度",
        "heading_changes": "与前 {days} 天相比",
        "heading_coverage": "覆盖范围与说明",
        "heading_methodology": "方法说明",
        "label_calls": "调用",
        "label_input": "输入 token",
        "label_output": "输出 token",
        "label_cache_read": "缓存读取 token",
        "label_cache_write": "缓存写入 token",
        "label_api_value": "API 等值",
        "label_pricing_coverage": "已定价 token",
        "label_unpriced": "未定价 token",
        "label_metered": "计量（额度）支出",
        "label_incremental": "额外现金（增量）支出",
        "label_credits": "消耗点数",
        "label_unvalued": "未分类调用",
        "label_unpriced_calls": "未定价调用",
        "label_provider_charges": "服务商报告的费用",
        "provider_charge_coverage": "（{calls} 次已记录调用中有 {confirmed} 次已确认）",
        "label_fees_monthly": "已知月度费用（{currency}）",
        "label_fees_window": "周期内费用（{currency}）",
        "label_usage_value": "归因用量价值",
        "label_difference": "估计价值对比（API 等值减费用）",
        "label_recording_since": "记录开始",
        "label_recording_last": "最近记录",
        "label_attributed": "已归因 token",
        "label_unattributed": "未归因 token",
        "label_ambiguous": "多归因 token",
        "change_was": "(之前 {value})",
        "col_model": "模型",
        "col_provider": "服务商",
        "col_calls": "调用",
        "col_tokens": "Token",
        "col_cost": "API 等值",
        "col_account": "账号",
        "col_cycle_ends": "周期结束",
        "col_days_left": "剩余天数",
        "col_status": "状态",
        "verdict_ahead": "消耗偏快",
        "verdict_on_track": "正常",
        "verdict_behind": "消耗偏慢",
        "verdict_exhausted": "已用完",
        "verdict_unknown": "未知",
        "note_no_calls": "此周期内没有记录到调用。",
        "note_partial": "记录开始于本周期内，因此数据不完整。",
        "note_unknown": "本周期记录覆盖不完整，无法给出用量。",
        "note_api_theoretical": "API 等值是理论公开价格，不是账单。",
        "note_lower_bound": "标有 ≥ 的数值为下限：部分用量未定价。",
        "note_unpriced_calls": "{calls} 次调用缺少完整用量或价格证据；未定价令牌为零不代表其价值为零。",
        "note_billing_rule_missing": "有 {calls} 次调用没有匹配的计费规则；请检查“费用”中的规则。",
        "note_billing_evidence_missing": "有 {calls} 次调用匹配了计费规则，但缺少 API 价格或供应商费用记录证据；请检查价格目录和已记录费用。",
        "note_billing_rules_unreadable": "无法读取计费规则，因此无法检查 {calls} 次调用是否匹配；请修复规则文件后重试。",
        "note_billing_reason_unknown": "有 {calls} 次调用未分类；现有记录无法说明是没有匹配规则，还是缺少价格/费用记录证据。请在“费用”中检查两者。",
        "note_actual_not_recorded": "实际服务商费用不完整：部分调用缺少逐次确认记录，或记录未覆盖整个周期。",
        "note_known_monthly_fees": "已知月度费用来自已保存的订阅声明，并非已确认付款。",
        "note_unknown_fee_accounts": "有 {count} 个订阅的费用未知；已知小计不包含这些费用。",
        "note_historical_fee_missing": "有 {count} 个当前订阅费用因历史费用证据缺失而无法分配至本周期；未推断生效日期。",
        "note_no_calls_spending": "此周期内没有记录到调用。",
        "note_metered_basis": "计量与现金数据遵循您的费用规则。",
        "note_fees_prorata": "费用按比例分摊到报告周期。",
        "note_partial_comparison": "部分输入数据不完整，请将对比视为近似值。",
        "note_unavailable_comparison": "无法对比：缺少费用、覆盖率或汇率数据。",
        "note_unattributed": "无人认领路由上的用量保持未归因。",
        "note_ambiguous": "多人认领路由上的用量只计数一次，不归因给任何人。",
        "note_allowance_current": "额度状态为当前状态，非周期数据：反映当前周期进度。",
        "note_no_memberships": "没有已确认的会员。",
        "note_no_models": "本周期内没有记录到模型。",
        "note_no_providers": "本周期内没有记录到服务商。",
        "spending_cycle": "当前计费周期",
        "note_cycle_excluded": "{calls} 个当前计费周期之外的调用未计入支出。",
        "note_cash_unknown": "没有匹配的费用规则，无法给出额外现金支出。",
        "note_credits_unknown": "需要匹配的点数规则才能给出点数消耗。",
        "note_partial_pricing": "价值对比需要两个周期都完整定价。",
        "note_previous_no_calls": "前一周期没有记录到调用，因此无法计算变化百分比。",
        "note_previous_insufficient": "已记录历史不足以覆盖前一周期，因此无法计算变化。",
        "note_previous_unavailable": "前一周期对比不可用。",
        "note_recon_gap": "自记录开始以来约漏记 {tokens}，数据可能低估实际用量。",
        "method_local": "本报告根据您记录的调用和会员数据在本地生成。除非您主动导出，否则不会离开您的设备。",
        "method_windows": "用量部分覆盖上述报告周期；额度状态反映生成时的当前计费周期。",
        "method_value": "API 等值按当前目录价格为记录的 token 计价。它不是您的实际支出，也不是别处的应付价格。",
        "method_missing": "破折号表示未知或不可用，绝不是零。只有记录确实为空时才会显示零。",
    },
}

_CURRENCY_SYMBOLS = {"USD": "$", "GBP": "£", "EUR": "€", "JPY": "¥", "INR": "₹"}


def _money(amount: Any, currency: str | None = "USD") -> Optional[str]:
    """Format a money figure, or None when it is unknown (never zero)."""
    if amount is None or isinstance(amount, bool):
        return None
    try:
        value = float(amount)
    except (TypeError, ValueError):
        return None
    symbol = _CURRENCY_SYMBOLS.get(str(currency or "USD"))
    text = f"{abs(value):.2f}"
    if symbol:
        text = f"{symbol}{text}"
    elif currency:
        text = f"{text} {currency}"
    return f"-{text}" if value < 0 else text


def _tokens(count: Any) -> Optional[str]:
    """Compact token count mirroring the desktop formatter."""
    if count is None or isinstance(count, bool):
        return None
    try:
        value = float(count)
    except (TypeError, ValueError):
        return None
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(int(value))


def _signed_money(amount: Any, currency: str | None = "USD") -> Optional[str]:
    text = _money(amount, currency)
    if text is None:
        return None
    return f"+{text}" if float(amount or 0) > 0 else text


def _escape(cell: Any) -> str:
    """Render data as literal Markdown text.

    Escapes structure characters (pipes, newlines), HTML delimiters and the
    inline-formatting characters that would otherwise change how a stored
    name looks once rendered, so exports read exactly like the preview.
    Characters that are harmless mid-line in table cells and list values
    (dashes, dots, hashes) are left alone to keep the raw file readable.
    """
    text = str(cell).replace("\r", "").replace("\n", " ")
    for char in ("\\", "|", "<", ">", "*", "_", "`", "[", "]", "!", "~"):
        text = text.replace(char, "\\" + char)
    return text


def _utc_date(value: Any) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(float(value), timezone.utc).strftime("%Y-%m-%d")
    text = str(value or "")
    return text[:10] if len(text) >= 10 else text


def _usage_section(S: Mapping[str, str], window_label: str, totals: Mapping[str, Any],
                   covers: bool, calls: int) -> dict[str, Any]:
    lines: list[dict[str, str]] = []
    notes: list[str] = []
    if calls == 0 and not covers:
        for key in ("label_calls", "label_input", "label_output",
                    "label_cache_read", "label_cache_write", "label_api_value",
                    "label_unpriced_calls"):
            lines.append({"label": S[key], "value": S["unknown"]})
        notes.append(S["note_unknown"])
        return {"id": "usage", "heading": S["heading_usage"], "window": window_label,
                "kind": "lines", "lines": lines, "notes": notes}
    lines.append({"label": S["label_calls"], "value": str(calls)})
    unpriced_calls = totals.get("unpriced_calls") or 0
    lines.append({"label": S["label_unpriced_calls"], "value": str(unpriced_calls)})
    for key, field in (("label_input", "input_tokens"), ("label_output", "output_tokens"),
                       ("label_cache_read", "cache_read_tokens"),
                       ("label_cache_write", "cache_write_tokens")):
        lines.append({"label": S[key], "value": _tokens(totals.get(field)) or S["unknown"]})
    value = _money(totals.get("list_usd"))
    unpriced = totals.get("unpriced_tokens") or 0
    if value is None:
        lines.append({"label": S["label_api_value"], "value": S["unknown"]})
    elif unpriced or unpriced_calls or not covers:
        lines.append({"label": S["label_api_value"], "value": f"≥{value}"})
        if unpriced:
            notes.append(S["note_lower_bound"])
    else:
        lines.append({"label": S["label_api_value"], "value": value})
    if calls == 0:
        notes.append(S["note_no_calls"])
    elif not covers:
        notes.append(S["note_partial"])
    if unpriced_calls:
        notes.append(S["note_unpriced_calls"].format(calls=unpriced_calls))
    if unpriced:
        notes.append(S["note_api_theoretical"])
    return {"id": "usage", "heading": S["heading_usage"], "window": window_label,
            "kind": "lines", "lines": lines, "notes": notes}


def _ranked_table(S: Mapping[str, str], sid: str, heading: str, window_label: str,
                  columns: list[str], rows: list[dict[str, Any]], empty_note: str,
                  covers: bool, calls: int, limit: int = 5) -> dict[str, Any]:
    ranked = sorted(rows, key=lambda r: (r.get("list_usd") is None,
                                         -(r.get("list_usd") or 0.0)))[:limit]
    table: list[list[str]] = []
    lower_bound = False
    incomplete_calls = 0
    for row in ranked:
        value = _money(row.get("list_usd"))
        incomplete_calls += int(row.get("unpriced_calls") or 0)
        if value is None:
            shown = S["unknown"]
        elif row.get("unpriced_tokens") or row.get("unpriced_calls") or not covers:
            shown = f"≥{value}"
            lower_bound = lower_bound or bool(row.get("unpriced_tokens"))
        else:
            shown = value
        table.append([str(row.get("name", "")), str(row.get("calls") or 0),
                      _tokens(row.get("tokens")) or S["unknown"], shown])
    notes = [S["note_lower_bound"]] if lower_bound else []
    if incomplete_calls:
        notes.append(S["note_unpriced_calls"].format(calls=incomplete_calls))
    if not table:
        notes.append(empty_note if calls or covers else S["note_unknown"])
    elif not covers:
        notes.append(S["note_partial"])
    return {"id": sid, "heading": heading, "window": window_label, "kind": "table",
            "columns": columns, "rows": table, "notes": notes}


def _value_section(S: Mapping[str, str], window_label: str, totals: Mapping[str, Any],
                   pricing: Mapping[str, Any], covers: bool, calls: int) -> dict[str, Any]:
    notes = [S["note_api_theoretical"]]
    if calls == 0 and not covers:
        lines = [
            {"label": S["label_api_value"], "value": S["unknown"]},
            {"label": S["label_pricing_coverage"], "value": S["unknown"]},
            {"label": S["label_unpriced"], "value": S["unknown"]},
            {"label": S["label_unpriced_calls"], "value": S["unknown"]},
        ]
        notes.append(S["note_unknown"])
        return {"id": "value", "heading": S["heading_value"], "window": window_label,
                "kind": "lines", "lines": lines, "notes": notes}
    value = _money(totals.get("list_usd"))
    unpriced = pricing.get("unpriced_tokens") or 0
    unpriced_calls = totals.get("unpriced_calls") or 0
    if value is None:
        shown: str = S["unknown"]
    elif unpriced or unpriced_calls or not covers:
        shown = f"≥{value}"
        if unpriced:
            notes.append(S["note_lower_bound"])
    else:
        shown = value
    coverage = pricing.get("coverage")
    if calls == 0 or not totals.get("tokens"):
        coverage_shown = S["unknown"]
    elif isinstance(coverage, (int, float)):
        coverage_shown = f"{coverage * 100:.1f}%"
    else:
        coverage_shown = S["unknown"]
    lines = [
        {"label": S["label_api_value"], "value": shown},
        {"label": S["label_pricing_coverage"], "value": coverage_shown},
        {"label": S["label_unpriced"], "value": _tokens(unpriced) or S["unknown"]},
        {"label": S["label_unpriced_calls"], "value": str(unpriced_calls)},
    ]
    if unpriced_calls:
        notes.append(S["note_unpriced_calls"].format(calls=unpriced_calls))
    if calls and not covers:
        notes.append(S["note_partial"])
    return {"id": "value", "heading": S["heading_value"], "window": window_label,
            "kind": "lines", "lines": lines, "notes": notes}


def _spending_section(S: Mapping[str, str], window_label: str,
                      billing: Mapping[str, Any], covers: bool, calls: int) -> dict[str, Any]:
    notes = [S["note_metered_basis"]]
    evidence = billing.get("evidence") or {}
    provider_reported = evidence.get("provider_reported") or {}
    confirmed_calls = provider_reported.get("calls") or 0
    provider_charge = (provider_reported.get("usd")
                       if provider_reported.get("basis") == "confirmed"
                       and confirmed_calls > 0 else None)
    provider_charge_value = _money(provider_charge) or S["unknown"]
    if provider_charge is not None and (confirmed_calls < calls or not covers):
        provider_charge_value += " " + S["provider_charge_coverage"].format(
            confirmed=confirmed_calls, calls=calls)
    provider_line = {"label": S["label_provider_charges"],
                     "value": provider_charge_value}
    if calls == 0 or confirmed_calls < calls or not covers:
        notes.append(S["note_actual_not_recorded"])
    excluded = billing.get("excluded_out_of_cycle") or 0
    scope = S["spending_cycle"] if excluded else window_label
    # Rule figures only span current billing cycles: calls the rules exclude
    # are disclosed rather than silently missing from a windowed total.
    if excluded:
        notes.append(S["note_cycle_excluded"].format(calls=excluded))
    if calls == 0 and not covers:
        lines = [
            {"label": S["label_metered"], "value": S["unknown"]},
            {"label": S["label_incremental"], "value": S["unknown"]},
            {"label": S["label_credits"], "value": S["unknown"]},
            provider_line,
        ]
        notes.append(S["note_unknown"])
        return {"id": "spending", "heading": S["heading_spending"], "window": scope,
                "kind": "lines", "lines": lines, "notes": notes}
    if calls == 0:
        lines = [
            {"label": S["label_metered"], "value": "$0.00"},
            {"label": S["label_incremental"], "value": "$0.00"},
            {"label": S["label_credits"], "value": "$0.00"},
            provider_line,
        ]
        notes.append(S["note_no_calls_spending"])
        return {"id": "spending", "heading": S["heading_spending"], "window": scope,
                "kind": "lines", "lines": lines, "notes": notes}
    unclassified_tokens = billing.get("unclassified_tokens") or 0
    unclassified_calls = billing.get("unclassified_calls") or 0
    unvalued = bool(unclassified_tokens or unclassified_calls)
    partial = unvalued or not covers

    def stated(amount: Any) -> str:
        text = _money(amount)
        if text is None:
            return S["unknown"]
        if float(amount or 0) == 0 and partial:
            return S["unknown"]
        return f"≥{text}" if partial else text

    def stated_cash(entry: Mapping[str, Any]) -> str:
        # An unknown basis means some calls escaped judgment: a zero is not
        # a known zero, and any positive subtotal is only a lower bound.
        if entry.get("basis") != "unknown":
            return stated(entry.get("usd"))
        text = _money(entry.get("usd"))
        if text is None or float(entry.get("usd") or 0) == 0:
            return S["unknown"]
        return f"≥{text}"

    incremental = evidence.get("incremental_cash") or {}
    lines = [
        {"label": S["label_metered"], "value": stated(billing.get("metered_usd"))},
        {"label": S["label_incremental"], "value": stated_cash(incremental)},
        {"label": S["label_credits"],
         "value": stated((evidence.get("credits_consumed") or {}).get("usd"))},
        provider_line,
    ]
    if (lines[1]["value"] == S["unknown"]
            or incremental.get("basis") == "unknown") and not partial:
        notes.append(S["note_cash_unknown"])
    if lines[2]["value"] == S["unknown"] and not partial:
        notes.append(S["note_credits_unknown"])
    if unvalued:
        if unclassified_tokens:
            notes.append(S["note_lower_bound"])
        if unclassified_calls:
            explained_calls = 0
            for field, note_key in (
                ("unclassified_missing_rule_calls", "note_billing_rule_missing"),
                ("unclassified_missing_evidence_calls", "note_billing_evidence_missing"),
                ("unclassified_rule_state_unknown_calls", "note_billing_rules_unreadable"),
            ):
                count = billing.get(field)
                if isinstance(count, int) and not isinstance(count, bool) and count > 0:
                    notes.append(S[note_key].format(calls=count))
                    explained_calls += count
            if explained_calls < unclassified_calls:
                notes.append(S["note_billing_reason_unknown"].format(
                    calls=unclassified_calls - explained_calls))
        lines.append({"label": S["label_unvalued"], "value": str(unclassified_calls)})
    if calls > 0 and not covers:
        notes.append(S["note_partial"])
    return {"id": "spending", "heading": S["heading_spending"], "window": scope,
            "kind": "lines", "lines": lines, "notes": notes}


def _attributed_pricing_partial(accounts: Any) -> bool:
    for row in accounts or []:
        usage = (row or {}).get("usage") or {}
        if (usage.get("unpriced_tokens") or 0) > 0 or (usage.get("unpriced_calls") or 0) > 0:
            return True
    return False


def _fees_section(S: Mapping[str, str], window_label: str,
                  headline: Mapping[str, Any], covers: bool, calls: int,
                  pricing_partial: bool, groups: Any = ()) -> dict[str, Any]:
    lines: list[dict[str, str]] = []
    group_rows = [g for g in (groups or []) if isinstance(g, dict)]
    group_by_currency = {str(g.get("currency") or "unknown"): g for g in group_rows}
    monthly = {str((e or {}).get("currency") or "unknown"): e
               for e in headline.get("fees_monthly_by_currency") or []}
    window = {str((e or {}).get("currency") or "unknown"): e
              for e in headline.get("fees_window_by_currency") or []}
    currencies = sorted(set(monthly) | set(window) | set(group_by_currency))
    unknown_fee_accounts = 0
    missing_window_accounts = 0
    for currency in currencies:
        group = group_by_currency.get(currency, {})
        monthly_amount = (monthly.get(currency) or {}).get("amount")
        monthly_complete = group.get("fee_complete", monthly_amount is not None)
        monthly_value = _money(monthly_amount, currency)
        if monthly_value is None or (not monthly_complete and float(monthly_amount or 0) == 0):
            monthly_value = S["unknown"]
        elif not monthly_complete:
            monthly_value = f"≥{monthly_value}"
        lines.append({"label": S["label_fees_monthly"].format(currency=currency),
                      "value": f"{monthly_value}/mo" if monthly_value != S["unknown"] else monthly_value})

        window_amount = (window.get(currency) or {}).get("amount")
        window_complete = group.get("window_fee_complete", window_amount is not None)
        window_value = _money(window_amount, currency)
        if window_value is None or (not window_complete and float(window_amount or 0) == 0):
            window_value = S["unknown"]
        elif not window_complete:
            window_value = f"≥{window_value}"
        lines.append({"label": S["label_fees_window"].format(currency=currency),
                      "value": window_value})
        unknown_fee_accounts += len(group.get("unknown_fee_accounts") or [])
        missing_window_accounts += len(group.get("unallocated_window_accounts") or [])
    if not currencies:
        lines.extend([
            {"label": S["label_fees_monthly"].format(currency="USD"), "value": S["unknown"]},
            {"label": S["label_fees_window"].format(currency="USD"), "value": S["unknown"]},
        ])
    # Declared fees stand on their own; the usage-derived lines below follow
    # the same coverage rules as every other section.
    lower = pricing_partial or not covers
    if calls == 0 and not covers:
        usage_shown: str | None = None
        difference_shown: str | None = None
    else:
        usage_text = _money(headline.get("usage_usd"))
        if usage_text is None or (headline.get("usage_usd") == 0 and lower):
            usage_shown = None
        else:
            usage_shown = f"≥{usage_text}" if lower else usage_text
        if usage_shown is None:
            difference_shown = None
        else:
            difference_text = _signed_money(headline.get("difference_usd"))
            difference_shown = (f"≥{difference_text}" if lower else difference_text) \
                if difference_text is not None else None
    lines.append({"label": S["label_usage_value"], "value": usage_shown or S["unknown"]})
    lines.append({"label": S["label_difference"], "value": difference_shown or S["unknown"]})
    bound = (usage_shown is not None and usage_shown.startswith("≥")) \
        or (difference_shown is not None and difference_shown.startswith("≥"))
    notes = [S["note_fees_prorata"], S["note_known_monthly_fees"]]
    if unknown_fee_accounts:
        notes.append(S["note_unknown_fee_accounts"].format(count=unknown_fee_accounts))
    if missing_window_accounts:
        notes.append(S["note_historical_fee_missing"].format(count=missing_window_accounts))
    if calls == 0 and not covers:
        notes.append(S["note_unknown"])
    elif calls == 0:
        notes.append(S["note_no_calls_spending"])
    else:
        if bound and pricing_partial:
            notes.append(S["note_lower_bound"])
        if calls > 0 and not covers:
            notes.append(S["note_partial"])
    status = headline.get("status")
    if status == "partial":
        notes.append(S["note_partial_comparison"])
    elif status != "ok":
        notes.append(S["note_unavailable_comparison"])
    return {"id": "fees", "heading": S["heading_fees"], "window": window_label,
            "kind": "lines", "lines": lines, "notes": notes}


def _allowances_section(S: Mapping[str, str], window_label: str,
                        accounts: list[Mapping[str, Any]]) -> dict[str, Any]:
    verdict_key = {"ahead": "verdict_ahead", "on_track": "verdict_on_track",
                   "behind": "verdict_behind", "exhausted": "verdict_exhausted"}
    rows: list[list[str]] = []
    for entry in accounts:
        cycle = entry.get("cycle") or {}
        days = cycle.get("days_remaining_display")
        state = (entry.get("rollup") or {}).get("state")
        rows.append([str(entry.get("label") or entry.get("account_id") or ""),
                     _utc_date(cycle.get("end")) or S["unknown"],
                     str(days) if isinstance(days, int) else S["unknown"],
                     S.get(verdict_key.get(state, ""), S["verdict_unknown"])])
    notes = [S["note_allowance_current"]]
    if not rows:
        notes.append(S["note_no_memberships"])
    return {"id": "allowances", "heading": S["heading_allowances"], "window": window_label,
            "kind": "table",
            "columns": [S["col_account"], S["col_cycle_ends"], S["col_days_left"],
                        S["col_status"]],
            "rows": rows, "notes": notes}


def _changes_section(S: Mapping[str, str], window_label: str, days: int,
                     previous: Mapping[str, Any],
                     totals: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    if not previous.get("comparable"):
        reason = previous.get("reason")
        note = (S["note_previous_no_calls"] if reason == "no_previous_calls" else
                S["note_previous_insufficient"] if reason == "insufficient_history" else
                S["note_previous_unavailable"])
        lines = [{"label": S["label_calls"], "value": S["unknown"]},
                 {"label": S["col_tokens"], "value": S["unknown"]},
                 {"label": S["label_api_value"], "value": S["unknown"]}]
        return {"id": "changes", "heading": S["heading_changes"].format(days=days),
                "window": window_label, "kind": "lines", "lines": lines, "notes": [note]}
    deltas = previous.get("deltas") or {}
    before = previous.get("totals") or {}

    def pct(key: str) -> str:
        delta = deltas.get(key)
        if not isinstance(delta, (int, float)) or isinstance(delta, bool):
            return S["unknown"]
        return f"{delta * 100:+.1f}%"

    calls_before = before.get("calls")
    tokens_before = _tokens(before.get("tokens"))
    # A value ratio is only fair when both windows are fully priced: mixing
    # an exact figure with a lower bound would present a precise-looking
    # percentage the data cannot support. Token and call counts compare.
    priced = not (before.get("unpriced_tokens") or totals.get("unpriced_tokens")
                  or before.get("unpriced_calls") or totals.get("unpriced_calls"))
    value_pct = pct("list_usd") if priced else S["unknown"]
    value_before = _money(before.get("list_usd"))
    if value_before is not None and (before.get("unpriced_tokens") or before.get("unpriced_calls")):
        value_before = (f"≥{value_before}"
                        if (before.get("list_usd") or 0) > 0 else None)
    lines = [
        {"label": S["label_calls"],
         "value": f"{pct('calls')} {S['change_was'].format(value=calls_before if calls_before is not None else S['unknown'])}"},
        {"label": S["col_tokens"],
         "value": f"{pct('tokens')} {S['change_was'].format(value=tokens_before or S['unknown'])}"},
        {"label": S["label_api_value"],
         "value": f"{value_pct} {S['change_was'].format(value=value_before or S['unknown'])}"},
    ]
    notes = [] if priced else [S["note_partial_pricing"]]
    return {"id": "changes", "heading": S["heading_changes"].format(days=days),
            "window": window_label, "kind": "lines", "lines": lines, "notes": notes}


def _coverage_section(S: Mapping[str, str], window_label: str,
                      coverage: Mapping[str, Any], recon: Mapping[str, Any]) -> dict[str, Any]:
    attribution = coverage.get("attribution") or {}
    lines = [
        {"label": S["label_recording_since"],
         "value": _utc_date(coverage.get("recording_since")) or S["unknown"]},
        {"label": S["label_attributed"],
         "value": _tokens(attribution.get("attributed_tokens")) or S["unknown"]},
        {"label": S["label_unattributed"],
         "value": _tokens(attribution.get("unattributed_tokens")) or S["unknown"]},
        {"label": S["label_ambiguous"],
         "value": _tokens(attribution.get("ambiguous_tokens")) or S["unknown"]},
    ]
    notes: list[str] = []
    if (attribution.get("unattributed_tokens") or 0) > 0:
        notes.append(S["note_unattributed"])
    if (attribution.get("ambiguous_tokens") or 0) > 0:
        notes.append(S["note_ambiguous"])
    if recon.get("status") == "gap" and recon.get("gap_tokens"):
        notes.append(S["note_recon_gap"].format(tokens=_tokens(recon.get("gap_tokens"))))
    return {"id": "coverage", "heading": S["heading_coverage"], "window": window_label,
            "kind": "lines", "lines": lines, "notes": notes}


def _render_markdown(title: str, period_label: str, generated_label: str,
                     sections: list[dict[str, Any]]) -> str:
    parts = [f"# {_escape(title)}", "", f"{_escape(period_label)} · {_escape(generated_label)}", ""]
    for section in sections:
        parts.append(f"## {_escape(section['heading'])}")
        parts.append("")
        if section.get("window"):
            parts.append(f"*{_escape(section['window'])}*")
            parts.append("")
        if section["kind"] == "table":
            columns = section.get("columns", [])
            parts.append("| " + " | ".join(_escape(c) for c in columns) + " |")
            parts.append("|" + "|".join("---" for _ in columns) + "|")
            for row in section.get("rows", []):
                parts.append("| " + " | ".join(_escape(c) for c in row) + " |")
            parts.append("")
        for line in section.get("lines", []):
            parts.append(f"- **{_escape(line['label'])}:** {_escape(line['value'])}")
        if section.get("lines"):
            parts.append("")
        for note in section.get("notes", []):
            parts.append(f"> {_escape(note)}")
        if section.get("notes"):
            parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def build_digest(*, days: int = 30, lang: str = "en", now: float | None = None,
                 event_db_path=None, state_db_path=None, membership_path=None,
                 plans: Mapping[str, Any] | None = None,
                 profiles_path=None, data_dir=None, catalogue: Catalogue | None = None,
                 native_snapshots: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Assemble the local digest for a trailing window.

    Read-only across the call store, membership store and catalogues.
    Figures are transmitted from the analytics, economics and weather
    builders; only the report prose lives here, in English and Chinese.
    Provider readings are never probed: the digest reports stored data.
    """
    from . import allowance_weather as weather

    moment = time.time() if now is None else float(now)
    days = max(1, min(int(days), 365))
    lang = lang if lang in STRINGS else "en"
    S = STRINGS[lang]
    book = catalogue if catalogue is not None else load_catalogue()
    if plans is None:
        from .membership_api import active_catalogue
        plans, _plans_source = active_catalogue(data_dir=data_dir)

    report = analytics.build_analytics_report(
        event_db_path, state_db_path=state_db_path, days=days, now=moment,
        catalogue=book, profiles_path=profiles_path)
    econ = economics.build_economics_report(
        days=days, trend_months=0, now=moment, event_db_path=event_db_path,
        state_db_path=state_db_path, membership_path=membership_path,
        plans=plans, profiles_path=profiles_path, catalogue=book)
    wx = weather.build_weather_report(
        now=moment, event_db_path=event_db_path, state_db_path=state_db_path,
        membership_path=membership_path, plans=plans, profiles_path=profiles_path,
        catalogue=book, native_snapshots=native_snapshots)

    window = report.get("window") or {}
    period_label = S["period_days"].format(
        days=days, start=_utc_date(window.get("since")), end=_utc_date(window.get("until")))
    generated_label = S["generated"].format(
        ts=datetime.fromtimestamp(moment, timezone.utc).strftime("%Y-%m-%d %H:%M"))
    cycle_label = S["cycle_as_of"].format(
        date=datetime.fromtimestamp(moment, timezone.utc).strftime("%Y-%m-%d"))
    filename = (f"spend-sense-digest-"
                f"{datetime.fromtimestamp(moment, timezone.utc).strftime('%Y-%m-%d')}"
                f"-{days}d-{lang}.md")

    totals = report.get("totals") or {}
    calls = totals.get("calls") or 0
    covers = bool((econ.get("coverage") or {}).get("recording_covers_window"))
    if not covers:
        conn = ustore.connect_reader(event_db_path)
        try:
            recording = ustore.recording_info(conn)
        finally:
            if conn is not None:
                conn.close()
        baseline = recording.get("baseline_at")
        since_ts = _window_epoch(window.get("since"))
        covers = (isinstance(baseline, (int, float)) and since_ts is not None
                  and baseline <= since_ts)

    sections: list[dict[str, Any]] = []
    sections.append(_usage_section(S, period_label, totals, covers, calls))
    sections.append(_ranked_table(
        S, "models", S["heading_models"], period_label,
        [S["col_model"], S["col_calls"], S["col_tokens"], S["col_cost"]],
        [{"name": r.get("model"), "calls": r.get("calls"), "tokens": r.get("tokens"),
          "list_usd": r.get("list_usd"), "unpriced_tokens": r.get("unpriced_tokens"),
          "unpriced_calls": r.get("unpriced_calls")}
         for r in report.get("by_model", [])], S["note_no_models"], covers, calls))
    sections.append(_ranked_table(
        S, "providers", S["heading_providers"], period_label,
        [S["col_provider"], S["col_calls"], S["col_tokens"], S["col_cost"]],
        [{"name": r.get("provider"), "calls": r.get("calls"), "tokens": r.get("tokens"),
          "list_usd": r.get("list_usd"), "unpriced_tokens": r.get("unpriced_tokens"),
          "unpriced_calls": r.get("unpriced_calls")}
         for r in report.get("by_route", [])], S["note_no_providers"], covers, calls))
    sections.append(_value_section(S, period_label, totals, report.get("pricing_coverage") or {},
                                   covers, calls))
    sections.append(_spending_section(S, period_label, report.get("billing") or {}, covers, calls))
    sections.append(_fees_section(S, period_label, econ.get("headline") or {}, covers, calls,
                                   _attributed_pricing_partial(econ.get("accounts")),
                                   econ.get("groups")))
    sections.append(_allowances_section(S, cycle_label, list(wx.get("accounts", []))))
    changes = _changes_section(S, period_label, days, report.get("previous") or {}, totals)
    if changes is not None:
        sections.append(changes)
    sections.append(_coverage_section(
        S, period_label, econ.get("coverage") or {},
        (wx.get("coverage") or {}).get("reconciliation") or {}))
    sections.append({"id": "methodology", "heading": S["heading_methodology"],
                     "window": "", "kind": "notes", "lines": [],
                     "notes": [S["method_local"], S["method_windows"], S["method_value"],
                               S["method_missing"]]})

    return {
        "ok": True,
        "generated_at": datetime.fromtimestamp(moment, timezone.utc).isoformat().replace("+00:00", "Z"),
        "days": days,
        "lang": lang,
        "title": S["title"],
        "period": {"label": period_label, "start": window.get("since"),
                   "end": window.get("until"), "timezone": window.get("timezone")},
        "sections": sections,
        "markdown": _render_markdown(S["title"], period_label, generated_label, sections),
        "filename": filename,
        "empty": calls == 0,
    }


def _window_epoch(value: Any) -> float | None:
    if value is None:
        return None
    try:
        text = str(value)
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None

