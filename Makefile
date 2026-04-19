.PHONY: test serve fmt check

PORT ?= 8080

test:
	node --test 'test/**/*.test.js'

serve:
	node tools/serve.js $(PORT)

fmt:
	@echo "no formatter configured yet"

check: test
