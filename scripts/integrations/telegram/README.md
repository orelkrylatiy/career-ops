# Telegram integration

Planned source adapter for configured Telegram channels.

MVP responsibilities: Telethon session/client boundary, recent-message fetch, stable `channel:message_id` source refs, source URLs, and raw metadata extraction. Vacancy filtering/normalization should remain reusable by the common discovery layer where possible.
