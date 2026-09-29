from pathlib import Path

import pytest

from scripts import goq_flow_guard as guard


def proposal(carrier, phase, *, count=1, printer="佐川", evidence=True, print_queue=False):
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


@pytest.mark.parametrize("carrier", ["sagawa", "sagawa120"])
def test_sagawa_flows_block_goq_api_label_request(carrier):
    status, errors, _ = guard.review_proposal(completed_state(carrier, "picking_print"), proposal(carrier, "label_request"))

    assert status == "blocked"
    assert f"phase_not_allowed_for_carrier:{carrier}:label_request" in errors


def test_sagawa120_requires_manifest_before_ship_history_export():
    state = completed_state("sagawa120", "picking_print", "ehiden_csv_export", "ehiden_import", "label_print")

    status, errors, _ = guard.review_proposal(state, proposal("sagawa120", "ship_history_export"))

    assert status == "blocked"
    assert "required_checkpoint_missing:sagawa120:manifest_print" in errors


def test_sagawa_does_not_allow_sagawa120_manifest_step():
    state = completed_state("sagawa", "picking_print", "ehiden_csv_export", "ehiden_import", "label_print")

    status, errors, _ = guard.review_proposal(state, proposal("sagawa", "manifest_print", print_queue=True))

    assert status == "blocked"
    assert "phase_not_allowed_for_carrier:sagawa:manifest_print" in errors


def test_sagawa120_post_label_verify_requires_full_120_flow():
    state = completed_state("sagawa120", "picking_print", "ehiden_csv_export", "ehiden_import", "label_print")

    status, errors, _ = guard.review_proposal(state, proposal("sagawa120", "post_label_verify"))

    assert status == "blocked"
    assert "required_checkpoint_missing:sagawa120:tracking_verify" in errors


def test_sagawa120_post_label_verify_passes_after_full_120_flow():
    state = completed_state(
        "sagawa120",
        "picking_print",
        "ehiden_csv_export",
        "ehiden_import",
        "label_print",
        "manifest_print",
        "ship_history_export",
        "goq_tracking_import",
        "tracking_verify",
    )

    status, errors, _ = guard.review_proposal(state, proposal("sagawa120", "post_label_verify"))

    assert status == "approved"
    assert errors == []


def test_sagawa_post_label_verify_does_not_require_120_only_steps():
    state = completed_state(
        "sagawa",
        "picking_print",
        "ehiden_csv_export",
        "ehiden_import",
        "label_print",
        "goq_tracking_import",
        "tracking_verify",
    )

    status, errors, _ = guard.review_proposal(state, proposal("sagawa", "post_label_verify"))

    assert status == "approved"
    assert errors == []
