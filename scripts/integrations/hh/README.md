# HH integration

Planned hh.ru source adapter.

Discovery responsibilities: fetch/search vacancies through the best supported API path, preserve `hh:<vacancy_id>` and canonical vacancy URL, paginate safely, and return normalized source items.

Future apply logic belongs in `scripts/actions/`, not here.
