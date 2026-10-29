from typing import Any
import os
import requests

from langchain_openai import ChatOpenAI
from lfx.base.models.model import LCModelComponent
from lfx.base.models.provider_ssrf import ensure_credential_endpoint_allowed, openai_compatible_client_kwargs
from lfx.field_typing import LanguageModel
from lfx.field_typing.range_spec import RangeSpec
from lfx.inputs.inputs import BoolInput, DictInput, DropdownInput, IntInput, SecretStrInput, SliderInput, StrInput
from lfx.log.logger import logger
from lfx.utils.secrets import secret_value_to_str

# Base URL otomatis mengarah ke gateway Flaz Cloud
DEFAULT_OPENAI_API_BASE = "https://ai.flaz.id/v1"

# Opsi model bawaan khusus Flaz Cloud yang diizinkan oleh API Key Anda
FALLBACK_MODELS = [
    "gpt-4.1-nano",
    "deepseek-v4-flash",
    "gpt-4.1-mini",
    "qwen3.8-flash",
    "MiniMax-M3.1-Flash-Preview",
    "MiniMax-M2.7-highspeed",
    "glm-5.3-flash"
]

class OpenAIModelComponent(LCModelComponent):
    display_name = "Flaz Cloud Model"
    description = "Generates text menggunakan LLM termurah & tercepat dari Flaz Cloud API."
    icon = "Zap"
    name = "FlazCloudModel"

    inputs = [
        *LCModelComponent.get_base_inputs(),
        IntInput(
            name="max_tokens",
            display_name="Max Tokens",
            advanced=True,
            info="The maximum number of tokens to generate. Set to 0 for unlimited tokens.",
            range_spec=RangeSpec(min=0, max=128000),
        ),
        DictInput(
            name="model_kwargs",
            display_name="Model Kwargs",
            advanced=True,
            info="Additional keyword arguments to pass to the model.",
        ),
        BoolInput(
            name="json_mode",
            display_name="JSON Mode",
            advanced=True,
            info="If True, it will output JSON regardless of passing a schema.",
        ),
        DropdownInput(
            name="model_name",
            display_name="Model Name",
            advanced=False,
            # Menghapus total konstanta OpenAI. Hanya menampilkan daftar model Flaz Cloud.
            options=FALLBACK_MODELS,
            value="qwen3.8-flash",
            combobox=True,
            real_time_refresh=True,
        ),
        StrInput(
            name="openai_api_base",
            display_name="Flaz API Base URL",
            advanced=True,
            info="Endpoint gateway API untuk pemrosesan token.",
            value=DEFAULT_OPENAI_API_BASE,
        ),
        SecretStrInput(
            name="api_key",
            display_name="Flaz API Key",
            info="Masukkan API Key sk-flaz-... Anda dari dashboard flaz.id.",
            advanced=False,
            value="OPENAI_API_KEY",
            required=True,
        ),
        SliderInput(
            name="temperature",
            display_name="Temperature",
            value=0.1,
            range_spec=RangeSpec(min=0, max=1, step=0.01),
            show=True,
        ),
        IntInput(
            name="seed",
            display_name="Seed",
            info="The seed controls the reproducibility of the job.",
            advanced=True,
            value=1,
        ),
        IntInput(
            name="max_retries",
            display_name="Max Retries",
            info="The maximum number of retries to make when generating.",
            advanced=True,
            value=5,
        ),
        IntInput(
            name="timeout",
            display_name="Timeout",
            info="The timeout for requests to OpenAI completion API.",
            advanced=True,
            value=700,
        ),
    ]

    def build_model(self) -> LanguageModel:  # type: ignore[type-var]
        logger.debug(f"Executing request with model: {self.model_name}")
        api_key_value = secret_value_to_str(self.api_key) if self.api_key else None

        model_kwargs = self.model_kwargs or {}
        if "api_key" in model_kwargs:
            logger.warning("api_key found in model_kwargs, removing to prevent conflicts")
            model_kwargs = dict(model_kwargs)
            del model_kwargs["api_key"]

        parameters = {
            "api_key": api_key_value,
            "model_name": self.model_name,
            "max_tokens": self.max_tokens or None,
            "model_kwargs": model_kwargs,
            "base_url": self.openai_api_base or DEFAULT_OPENAI_API_BASE,
            "max_retries": self.max_retries,
            "timeout": self.timeout,
        }

        ensure_credential_endpoint_allowed(
            api_key_value,
            self.openai_api_base,
            default_url=DEFAULT_OPENAI_API_BASE,
            sdk_env_fallback="OPENAI_API_KEY",
        )

        target_base = self.openai_api_base or DEFAULT_OPENAI_API_BASE
        from urllib.parse import urlparse
        parsed = urlparse(target_base)
        hostname = (parsed.hostname or "").lower()
        if not (hostname == "flaz.id" or hostname.endswith(".flaz.id")):
            raise ValueError(f"SSRF Protection: Host '{hostname}' tidak diizinkan. Hanya domain resmi Flaz Cloud (*.flaz.id) yang diperbolehkan.")

        parameters.update(openai_compatible_client_kwargs(self.openai_api_base, default_url=DEFAULT_OPENAI_API_BASE))

        # Pengecekan lokal mandiri untuk menonaktifkan parameter pada model tipe reasoning/penalaran
        model_lower = str(self.model_name).lower()
        is_reasoning = "o1" in model_lower or "o3" in model_lower or "reasoner" in model_lower

        if not is_reasoning:
            parameters["temperature"] = self.temperature if self.temperature is not None else 0.1
            parameters["seed"] = self.seed
        else:
            logger.debug(f"{self.model_name} adalah model reasoning. Mengabaikan temperature & seed.")

        parameters["stream_usage"] = True
        output = ChatOpenAI(**parameters)
        if self.json_mode:
            output = output.bind(response_format={"type": "json_object"})

        return output

    def _get_exception_message(self, e: Exception):
        try:
            from openai import BadRequestError, NotFoundError
        except ImportError:
            return None
        if isinstance(e, NotFoundError):
            body = getattr(e, "body", None) or {}
            if isinstance(body, dict) and body.get("code") == "model_not_found":
                return (
                    f"Model '{self.model_name}' tidak diizinkan atau tidak ditemukan pada hak akses API Key Anda. "
                    "Gunakan gpt-4.1-nano atau deepseek-v4-flash."
                )
        if isinstance(e, BadRequestError):
            message = e.body.get("message")
            if message:
                return message
        return None

    def update_build_config(self, build_config: dict, field_value: Any, field_name: str | None = None) -> dict:
        """Sinkronisasi dinamis dropdown model langsung ke daftar aktif akun Flaz Cloud Anda."""
        
        if field_name in {"api_key", "openai_api_base"} and field_value:
            base_url = build_config.get("openai_api_base", {}).get("value") or DEFAULT_OPENAI_API_BASE
            
            # Validasi Keamanan SSRF: Hanya izinkan domain resmi flaz.id
            from urllib.parse import urlparse
            parsed = urlparse(base_url)
            hostname = (parsed.hostname or "").lower()
            if not (hostname == "flaz.id" or hostname.endswith(".flaz.id")):
                logger.warning(f"SSRF Protection: Permintaan ke '{base_url}' diblokir. Hanya domain resmi *.flaz.id yang diizinkan.")
                return build_config
            api_key = build_config.get("api_key", {}).get("value")
            
            if api_key == "OPENAI_API_KEY":
                api_key = os.environ.get("OPENAI_API_KEY", "")

            if api_key:
                try:
                    actual_key = secret_value_to_str(api_key) if hasattr(api_key, "value") else str(api_key)
                    
                    headers = {"Authorization": f"Bearer {actual_key}"}
                    response = requests.get(f"{base_url.rstrip('/')}/models", headers=headers, timeout=5)
                    
                    if response.status_code == 200:
                        data = response.json()
                        fetched_models = [model["id"] for model in data.get("data", [])]
                        
                        if fetched_models:
                            build_config["model_name"]["options"] = fetched_models
                            logger.info(f"Berhasil sinkronisasi {len(fetched_models)} model dari Flaz Cloud.")
                except Exception as e:
                    logger.error(f"Gagal mengambil daftar model dinamis: {str(e)}")

        # Logika UI responsif untuk menyembunyikan kolom jika beralih ke model tipe reasoning
        if field_name == "model_name":
            model_lower = str(field_value).lower()
            if "o1" in model_lower or "o3" in model_lower or "reasoner" in model_lower:
                build_config["temperature"]["show"] = False
                build_config["seed"]["show"] = False
                if "system_message" in build_config:
                    build_config["system_message"]["show"] = False
            else:
                build_config["temperature"]["show"] = True
                build_config["seed"]["show"] = True
                if "system_message" in build_config:
                    build_config["system_message"]["show"] = True
                    
        return build_config
