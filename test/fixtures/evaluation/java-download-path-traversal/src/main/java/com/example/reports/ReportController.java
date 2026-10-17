package com.example.reports;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ReportController {
    private static final Path REPORTS = Paths.get("reports").toAbsolutePath().normalize();

    @GetMapping("/reports")
    public ResponseEntity<byte[]> download(@RequestParam String name) throws IOException {
        Path file = REPORTS.resolve(name);
        return ResponseEntity.ok(Files.readAllBytes(file));
    }
}
