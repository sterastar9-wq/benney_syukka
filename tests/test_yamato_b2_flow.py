"""ベニー様版ヤマト系（B2クラウドCSV経路）のチェックポイント順序テスト。"""
from pathlib import Path

import pytest

from scripts import goq_flow_guard as guard


def proposal(carrier, phase, *, count=1, printer="ヤマト", evidence=True, print_queue=False):
    return guard.Proposal(
        session="test",
        carrier=carrier,
        phase=phase,
        target_count=count,
        printer=printer,
        job_key=f"test-{carrier}-{phase}",
        evidence_file=Path("evidence.json") if evidence else None,
        csv_file=None,
        target_hash="",
        note="",
        allow_reprint=False,
        require_picking_before_label=True,
        print_queue_checked=print_queue,
        allow_sagawa120_goq_api=False,
    )


def completed_state(carrier, *phases):
    return {
        "policy": {},
        "checkpoints": {
            f"{carrier}:{phase}": {
                "status": guard.STATUS_COMPLETED,
                "carrier": carrier,
                "phase": phase,
                "target_count": 1,
                "action_key": f"{carrier}:{phase}:1",
            }
            for phase in phases
        },
    }


@pytest.mark.parametrize("carrier", ["yamato", "compact", "nekopos"])
def test_yamato_family_blocks_goq_api_label_request(carrier):
    status, errors, _ = guard.review_proposal(completed_state(carrier, "picking_print"), proposal(carrier, "label_request"))

    assert status == "blocked"
    assert f"phase_not_allowed_for_carrier:{carrier}:label_request" in errors


def test_yamato_b2_csv_export_allowed_before_picking_print():
    # B2用CSVの出力は読み取りなので、点検のためピッキングより前でよい
    status, errors, _ = guard.review_proposal(completed_state("yamato"), proposal("yamato", "b2_csv_export"))

    assert "required_checkpoint_missing:yamato:picking_print" not in errors


def test_yamato_b2_import_requires_picking_print():
    # 送り状が作られる B2取込みは、ピッキングリストの印刷の後でなければならない
    status, errors, _ = guard.review_proposal(completed_state("yamato", "b2_csv_export"), proposal("yamato", "b2_import"))

    assert status == "blocked"
    assert "required_checkpoint_missing:yamato:picking_print" in errors


def test_yamato_label_print_requires_b2_import():
    state = completed_state("yamato", "picking_print", "b2_csv_export")

    status, errors, _ = guard.review_proposal(state, proposal("yamato", "label_print", print_queue=True))

    assert status == "blocked"
    assert "required_checkpoint_missing:yamato:b2_import" in errors


def test_yamato_label_print_passes_after_b2_import():
    state = completed_state("yamato", "picking_print", "b2_csv_export", "b2_import")

    status, errors, _ = guard.review_proposal(state, proposal("yamato", "label_print", print_queue=True))

    assert status == "approved", errors
    assert errors == []


def test_nekopos_label_print_rejects_yamato_printer():
    state = completed_state("nekopos", "picking_print", "b2_csv_export", "b2_import")

    status, errors, _ = guard.review_proposal(state, proposal("nekopos", "label_print", printer="ヤマト", print_queue=True))

    assert status == "blocked"
    assert any(error.startswith("printer_mismatch") for error in errors), errors


def test_yamato_post_label_verify_requires_tracking_roundtrip():
    state = completed_state("yamato", "picking_print", "b2_csv_export", "b2_import", "label_print")

    status, errors, _ = guard.review_proposal(state, proposal("yamato", "post_label_verify"))

    assert status == "blocked"
    assert "required_checkpoint_missing:yamato:tracking_verify" in errors
