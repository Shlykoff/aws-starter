"""read_fields(): best-effort field lookup. Also used on documents that failed the schema, so it
must never raise, only report a missing value as None."""

from helpers import make_submission

from app.xml_input import parse_xml, read_fields


def test_the_senders_name_is_parsed():
    fields = read_fields(parse_xml(make_submission(sender="aws-starter")))

    assert fields.sender == "aws-starter"


def test_the_senders_e_mail_address_is_parsed_as_is():
    # PartyName was widened to allow "@": the sender's identity is now the requester's e-mail.
    fields = read_fields(parse_xml(make_submission(sender="shlykoff@gmail.com")))

    assert fields.sender == "shlykoff@gmail.com"


def test_recipient_message_id_and_subject_are_still_parsed_alongside_sender():
    fields = read_fields(parse_xml(make_submission(recipient="Partner OK")))

    assert fields.recipient == "Partner OK"
    assert fields.message_id is not None
    assert fields.subject is not None


def test_a_document_without_a_sender_element_parses_as_none_not_an_error():
    # Well-formed, right namespace, but shaped as if Sender did not exist (an older document, or
    # anything read_fields() is asked to look at before/without schema validation): it must not
    # raise, only report the value as unreadable, the same way a missing Recipient already does.
    body = b"""<?xml version="1.0" encoding="UTF-8"?>
<Submission xmlns="urn:aws-starter:submission:v1" version="1">
  <Header>
    <MessageId>01M30JDSMHY8CRX59V35WV731S</MessageId>
    <SentAt>2026-09-20T23:29:07.123Z</SentAt>
    <Recipient><Name>Partner OK</Name></Recipient>
  </Header>
  <Content>
    <Subject>Delivery schedule</Subject>
    <Text>Please confirm the schedule for next week.</Text>
  </Content>
</Submission>
"""

    fields = read_fields(parse_xml(body))

    assert fields.sender is None
    assert fields.recipient == "Partner OK"  # everything else still reads fine


def test_a_sender_element_with_no_name_child_parses_as_none():
    body = b"""<?xml version="1.0" encoding="UTF-8"?>
<Submission xmlns="urn:aws-starter:submission:v1" version="1">
  <Header>
    <MessageId>01M30JDSMHY8CRX59V35WV731S</MessageId>
    <SentAt>2026-09-20T23:29:07.123Z</SentAt>
    <Sender></Sender>
    <Recipient><Name>Partner OK</Name></Recipient>
  </Header>
  <Content>
    <Subject>Delivery schedule</Subject>
    <Text>Please confirm the schedule for next week.</Text>
  </Content>
</Submission>
"""

    fields = read_fields(parse_xml(body))

    assert fields.sender is None
