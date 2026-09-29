---
name: goq-amazon-routing
description: Route GoQ System orders from Amazon振分用 or 発送待ち into the correct shipping status by judging GoQ商品行の販売単位（価格後ろの「円 x N個」） and destination. Use when Codex is asked to judge or perform Amazon order routing, carrier/status assignment, or move GoQ orders into 佐川, ヤマト, コンパクト, ネコポス, or 佐川120サイズ以上 statuses.
---

# GoQ Amazon Routing

## Core Rule

Treat routing as a paired update:

1. Change the delivery carrier.
2. Change the order status.

Do not move only the status when the carrier field still points to a different carrier. Statuses such as `佐川`, `ヤマト`, `コンパクト`, and `ネコポス徳島` are mostly separated by shipping carrier, so carrier and status must agree before the work is considered routed.

## Quantity Terms

Use the user's terms exactly:

- `販売単位` means the quantity after the price in the GoQ product line, such as `6,280円 x 1個`. In this example, the sales unit / order-line quantity is `1個`.
- Product-pack text such as `×6個セット`, `1200ml×N`, `child04-box`, or `s6` describes the contents of one sold line. Do not call this `販売単位` in this workflow.
- Actual shipment volume still depends on both: product-pack contents and the GoQ sales unit (`円 x N個`).

For screening 佐川 or ヤマト statuses for possible `佐川120サイズ以上`, first look for product lines where the GoQ sales unit (`円 x N個`) is `2個` or more. These are candidates, not automatic moves.

Also screen orders with multiple product lines even when each GoQ sales unit is `x 1個`. A single line may look small, but the shipment is judged by the combined product-pack contents and quantities across the whole order. Sum actual units, liquid/product capacity, weight, and packing volume across all lines before deciding whether the order is a `佐川120サイズ以上` candidate or a normal multi-parcel `佐川` / `ヤマト` shipment.

## Size Judgment

Judge by actual shipment quantity, not by a single physical unit.

- Read the GoQ sales unit from the price suffix: `円 x N個`.
- Also read product-pack contents when relevant: examples include `child01-box` = 1 unit, `child04-box` = 4 units, `s6` = 6-pack when the product name also supports it.
- Consider total volume, weight, shape, liquid/bottle risk, and packing material.
- Small items that fit ネコポス alone may not fit after quantity multiplication.
- For uncertain sizes, use the safer larger service and report the uncertainty.

The user will teach special 120サイズ以上 rules later. Until then, do not invent detailed 120+ heuristics beyond obvious large/heavy cases.

## 120 Size Candidate Rules

For liquid or dense products with capacity/weight notation such as `g`, `kg`, `ml`, or `L`, use this screening rule when checking `佐川` or `ヤマト` statuses. Apply it broadly to household liquids, drinks, automotive additives, car-care liquids, and similar products.

1. Read product-pack contents, such as `x6個セット`, `child04-box`, or `s6`.
2. Read the GoQ sales unit from the price suffix, such as `6,680円 x 4個`.
3. Calculate actual shipped units: `product-pack count × GoQ sales unit`.
   For multi-line orders, calculate this per line and then judge the combined order total.
4. For products over roughly `2000g` / `2000ml` per unit, if actual shipped units are `6` or fewer, the order may fit the normal 100-size route.
5. If actual shipped units are `7` or more, the order becomes a `佐川120サイズ以上` candidate.
6. Before moving to `佐川120サイズ以上`, check the practical single-parcel weight limit.

Use `24kg` as the practical single-parcel limit, not the official `25kg` limit. Real shipping weight includes the liquid/product, outer packaging, carton, and cushioning. If liquid/product capacity alone is `24kg` or more, do not ask for confirmation and do not move the order to `佐川120サイズ以上` as a single parcel.
Do not use total weight over 24kg as a reason to remove the row from routing candidates. It is still a heavy-parcel blocker until the minimum parcel count is calculated and the ordinary-vs-Sagawa120 route is decided and applied.

When the single-parcel weight limit is exceeded, keep or route the order as ordinary `佐川` or `ヤマト` and handle it as multiple parcels, usually `2個口`.

When a shipment cannot fit into one parcel, compare parcel count by service size instead of automatically keeping the ordinary 100-size route. If `佐川120サイズ以上` reduces the number of parcels, use the 120-size route because fewer parcels is usually cheaper. Example: `2100g × 6個セット`, GoQ sales unit `x 4個` = 24 units. With ordinary 佐川100サイズ, pack 6 units per parcel -> 4 parcels. With 佐川120サイズ, pack 8 units per parcel -> 3 parcels. Choose `佐川120サイズ以上` because it reduces parcel count.

Examples:

- `2100g × 6個セット`, GoQ sales unit `x 1個`: actual units `6`, liquid weight `12.6kg`; normal 100-size route candidate.
- `2100g × 6個セット`, GoQ sales unit `x 2個`: actual units `12`, liquid weight `25.2kg`; not `佐川120サイズ以上`, because liquid weight alone exceeds `24kg`; route as ordinary `佐川` or `ヤマト` with `2個口`.
- `2650g × child01-box`, GoQ sales unit `x 9個`: actual units `9`, liquid weight `23.85kg`; can fit `佐川120サイズ以上` by current learned rule.
- `2650g × child01-box`, GoQ sales unit `x 10個`: actual units `10`, liquid weight `26.5kg`; not `佐川120サイズ以上`; route as ordinary `佐川` or `ヤマト` with `2個口`.

## Destination Split

Use the user's active carrier policy:

- `ネコポス`
- `宅急便コンパクト`
- `佐川60〜100サイズ（東日本）`
- `ヤマト60〜100サイズ（西日本）`
- `佐川120サイズ以上（全国）`

For ordinary 60〜100サイズ, split east/west by destination region according to the user's routing policy. When the region boundary is not yet known from memory, inspect examples or ask before changing live orders.

## GoQ Operation

Use this workflow for live GoQ status routing:

1. Confirm the current GoQ page, target order count, GoQ ID, order number, product, destination, current carrier, and current status.
2. Decide the target route from GoQ sales unit, product-pack contents, package size, and destination.
3. Check only the target row(s), for example `input[name="order_number[]"]`.
4. In the processing panel, set `配送業者` / `trader_type` to the target carrier and press its nearby `変更` button.
5. Reconfirm or reselect the target row(s), because the page may refresh or clear selection.
6. In the processing panel, set `受注ステータス` / `status_id` to the target status and press its nearby `変更` button.
7. Open or verify the destination status and confirm the target GoQ ID is present with the expected carrier.

To increase parcel count without changing status:

1. Select only the target order checkbox.
2. In the processing panel, use the `一括入力` row.
3. Set `inputstype` to `個口数` (`value="10"` in the current UI).
4. Enter the parcel count in `input_word`, such as `2`.
5. Press the adjacent `上書き` button in the same `一括入力` row.
6. Verify the carrier display changed, for example `佐川急便 [2個口]`.

When an order should move to `佐川120サイズ以上` and also needs multiple parcels, update parcel count first, verify the carrier display includes the new parcel count, then reselect the order and change `status_id` to `42`. Example: `2100g ×6個セット`, GoQ sales unit `x 4個` = 24 units; choose 120-size 8 units per parcel -> `3個口`, then move to `佐川120サイズ以上`.

For both `佐川` and `ヤマト` statuses, distinguish these two operations:

- If the order only needs more parcels and `佐川120サイズ以上` does not reduce the parcel count, keep the current status/carrier and only overwrite `個口数`. Example: two heavy 6-pack liquid lines totaling 12 actual units; 100-size is 2 parcels and 120-size is also 2 parcels, so keep `ヤマト` and set `ヤマト運輸 [2個口]`.
- If `佐川120サイズ以上` reduces the parcel count, first overwrite `個口数` to the 120-size parcel count, verify the carrier display such as `佐川急便 [3個口]`, then move the order to `佐川120サイズ以上` (`status_id=42`). This is the learned status-move workflow.

## Delivery Date/Time Missing Check

GoQ sometimes fails to reflect delivery date/time into the order list columns when both date and time appear in the `発注元 ひとことメモ 備考` column. This is the learned `日時指定チェック` workflow.

This check applies broadly to shipping statuses, not only `佐川` or `ヤマト`. Run it whenever reviewing operational order statuses such as `発送待ち`, `Amazon振分用`, `佐川`, `ヤマト`, `コンパクト`, `佐川120サイズ以上`, and other active shipping statuses.

Exclude `ネコポス` statuses from delivery date/time checks because Nekopos does not support delivery date/time designation by service specification.

During list review, scan each order row for mismatches:

- In the order list table, the current column positions are:
  - `配送業者`: cell 11
  - `お届け日指定`: cell 12
  - `お届け時間帯`: cell 13
  - `発注元 ひとことメモ 備考`: cell 17
- If cell 17 includes a date and/or time but the corresponding delivery date/time cell is blank, open the order number link (`order_details_beta.php?...oid=...`) in a separate tab and inspect the detail page before making changes.
- Do not treat time-only memo text such as `[配送日時指定] 18:00-20:00` as a missing date. Only set what is actually specified in the memo.

On the detail page, the relevant fields currently are:

- `a60`: お届け日指定
- `a61`: お届け時間帯
- `a54`: 備考 / original memo containing `[配送日時指定]`

To fix a missing delivery time:

1. Open the order detail page in a separate tab from the order number link.
2. Read the date/time from `a54`.
3. Confirm `a60` already contains the requested delivery date when a date is present.
4. Set `a61` to the requested delivery time. The UI may store options with `～` while the memo uses `-`; treat these as equivalent.
5. Press `入力内容を反映する`.
6. Return to the status list and verify `お届け時間帯` is populated.

Learned examples from `佐川` status:

- `185964`: list memo `[配送日時指定] 2026-06-08(月) 8:00-12:00`; list date is `2026-06-08`, time is blank. Detail page has `a60=2026-06-08`, `a61` unselected, `a54` contains the date/time.
- `185903`: list memo `[配送日時指定] 2026-06-09(火) 19:00-21:00`; list date is `2026-06-09`, time is blank. Detail page has `a60=2026-06-09`, `a61` unselected, `a54` contains the date/time.
- `185684`: list memo `[配送日時指定] 2026-06-10(水) 18:00-20:00`; list date is `2026-06-10`, time is blank. Detail page has `a60=2026-06-10`, `a61` unselected, `a54` contains the date/time.

These examples were fixed by setting `a61` to `8:00-12:00`, `19:00～21:00`, and `18:00～20:00` respectively, then saving with `入力内容を反映する`.

Known status IDs from the current GoQ UI:

- `佐川`: `28`
- `ヤマト`: `30`
- `コンパクト`: `29`
- `ネコポス徳島`: `31`
- `佐川120サイズ以上`: `42`
- `Amazon振分用`: `22`

Known carrier values:

- `佐川急便`
- `ヤマト運輸`

## Guardrails

- Treat same-label buttons carefully. There are multiple `変更` buttons; choose the one adjacent to the correct select (`trader_type` for carrier, `status_id` for status).
- Do not use shipping-label issue buttons during routing.
- Do not print, issue labels, enter ship dates, or send Amazon shipment notifications unless explicitly requested.
- If there is more than one row, verify every selected row belongs to the same intended route before applying bulk changes.
- After changing carrier, assume selection may be lost and recheck the target selection before changing status.
- If live page state conflicts with the intended route, stop and report the mismatch.
