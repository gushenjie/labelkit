from server.core.review import _friendly_infra_message, is_infra_review_note


def test_infra_review_note_detection():
    assert is_infra_review_note(
        "Error code: 403 - {'error': {'message': 'Access denied.', 'code': 'access_denied'}}"
    )
    assert is_infra_review_note("DASHSCOPE_API_KEY not configured")
    assert not is_infra_review_note("框偏右，漏标鸟窝")
    assert not is_infra_review_note("")


def test_friendly_infra_message_for_access_denied():
    message = _friendly_infra_message(
        Exception("Error code: 403 - {'error': {'code': 'access_denied'}}")
    )
    assert "无访问权限" in message
    assert "access_denied" not in message.lower()
