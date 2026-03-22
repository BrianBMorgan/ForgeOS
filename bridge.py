import os
import subprocess
from google import genai
from google.genai import types

# 1. Config
API_KEY = "AIzaSyAuye5-4pp6yCa0lQA2hJXArZwf0NPOD4Y"
REPO_PATH = "/Users/brianmorgan/ForgeOS"
MODEL_ID = "gemini-2.5-pro"

client = genai.Client(api_key=API_KEY)

# 2. Local Tools (The Handshake)
def read_repo_file(path: str) -> str:
    full_path = os.path.join(REPO_PATH, path)
    print(f"--- [TOOL CALL] Reading {path} ---")
    with open(full_path, 'r') as f:
        return f.read()

def push_repo_update(path: str, content: str, message: str) -> str:
    full_path = os.path.join(REPO_PATH, path)
    print(f"--- [TOOL CALL] Pushing update to {path} ---")
    with open(full_path, 'w') as f:
        f.write(content)
    subprocess.run(["git", "add", path], cwd=REPO_PATH)
    subprocess.run(["git", "commit", "-m", message], cwd=REPO_PATH)
    subprocess.run(["git", "push", "origin", "main"], cwd=REPO_PATH)
    return f"Successfully pushed {path}."

# 3. The Fix Logic
print(f"--- FIXING TOOL SCHEMA IN {MODEL_ID} ---")

system_prompt = """You are the ForgeOS Architect. 
Critical Fix: Gemini uses 'parameters' for tool schemas, NOT 'input_schema'.
1. Read 'server/index.js'.
2. Find all tool definitions (FORGE_TOOLS).
3. Change 'input_schema' to 'parameters' for every tool.
4. Ensure the tools are passed correctly to the Gemini client in the orchestration route.
5. PUSH the fix to GitHub."""

chat = client.chats.create(
    model=MODEL_ID,
    config=types.GenerateContentConfig(
        tools=[read_repo_file, push_repo_update],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=False),
        system_instruction=system_prompt
    )
)

response = chat.send_message("Fix the 'input_schema' error in 'server/index.js' now.")
print(f"\nArchitect Final Report:\n{response.text}")
