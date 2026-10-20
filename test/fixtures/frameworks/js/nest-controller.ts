import { Body, Controller, Get, Param, Post } from "@nestjs/common";

@Controller("notes")
export class NotesController {
  @Get()
  list(): string[] {
    return [];
  }

  @Get(":id")
  find(@Param("id") id: string): string {
    return id;
  }

  @Post()
  create(@Body() body: { text: string }): { text: string } {
    return body;
  }
}
