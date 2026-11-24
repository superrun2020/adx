"""Send a single contract verification message through authenticated QQ SMTP."""
import datetime
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formatdate, make_msgid


def send(recipient, code):
    sender = os.environ["CONTRACT_MAIL_FROM"]
    message = EmailMessage()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    message["Date"] = formatdate(localtime=False)
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = "AdX contract verification " + stamp
    message["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[1])
    message.set_content(
        "Your JungleLabs AdX contract verification code is " + code
        + ". It expires in 15 minutes. If you did not request this code, ignore this email."
    )
    with smtplib.SMTP_SSL("smtp.qq.com", 465, context=ssl.create_default_context(), timeout=15) as client:
        client.login(os.environ["CONTRACT_SMTP_USER"], os.environ["CONTRACT_SMTP_PASSWORD"])
        client.sendmail(sender, [recipient], message.as_bytes(policy=SMTP))


if __name__ == "__main__":
    try:
        item = json.load(sys.stdin)
        send(item["recipient"], item["code"])
    except smtplib.SMTPResponseException as exc:
        sys.exit("smtp_" + str(exc.smtp_code))
    except Exception as exc:
        sys.exit(type(exc).__name__)
