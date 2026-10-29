from langflow.base.io.chat import ChatComponent
from langflow.io import MultilineInput, Output
from langflow.schema.message import Message


class ChatOutput(ChatComponent):
    display_name = "Chat Output"
    description = "Displays run summary report in the Playground."
    icon = "MessagesSquare"
    name = "ChatOutput"

    inputs = [
        MultilineInput(
            name="input_value",
            display_name="Input",
            info="Message or report to display in Playground.",
            value="",
        ),
    ]

    outputs = [
        Output(display_name="Message", name="message", method="build_message"),
    ]

    def build_message(self) -> Message:
        val = self.input_value
        if hasattr(val, "data"):
            val = val.data
        if isinstance(val, dict):
            text = val.get("text") or val.get("alert_text") or (val.get("summary") and str(val.get("summary"))) or str(val)
        else:
            text = str(val or "")

        session_id = getattr(self, "session_id", None)
        flow_id = getattr(self.graph, "flow_id", None) if hasattr(self, "graph") else None

        message = Message(
            text=text,
            sender="Machine",
            sender_name="AI",
            session_id=session_id,
            flow_id=flow_id,
        )

        try:
            from langflow.memory import store_message
            store_message(message, flow_id=flow_id)
        except Exception:
            pass

        try:
            if hasattr(self, "store_message"):
                self.store_message(message)
        except Exception:
            pass

        self.status = message
        return message
