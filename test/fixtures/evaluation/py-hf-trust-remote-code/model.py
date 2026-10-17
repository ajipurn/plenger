from transformers import AutoModelForCausalLM

model = AutoModelForCausalLM.from_pretrained("acme/custom-model", trust_remote_code=True)
